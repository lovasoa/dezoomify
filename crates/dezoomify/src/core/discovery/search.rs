//! One request table owns reads; decoder continuations consume their results.
//! Local evidence runs before network admission, and only distinct remote reads
//! occupy the bounded stream. Permissions are deferred until accessible work ends.

use super::*;
use futures_util::{FutureExt, StreamExt, stream::FuturesUnordered};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone)]
enum Read {
    Response(Arc<ParsedResponse>),
    NeedsAccess,
}

#[derive(Default)]
enum State {
    #[default]
    Queued,
    Reading,
    Complete(Result<Read, Error>),
    Exhausted,
}

/// Specificity first; shorter paths and stable input/format order break ties.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
struct Priority(Specificity, usize, usize, usize);

struct Branch {
    spec: FormatSpec,
    priority: Priority,
    parsed: ParsedResource,
    history: Vec<ReadResource>,
    canonical_uri: Option<String>,
    observation: bool,
}

struct Pending {
    branch: Branch,
    decoder: Option<Decoder>,
    canonical: bool,
}

#[derive(Default)]
struct Resource {
    supplied: Option<Arc<Vec<u8>>>,
    state: State,
    waiting: Vec<Pending>,
    root: Option<Priority>,
    interactive: bool,
}

impl Resource {
    fn priority(&self) -> Option<Priority> {
        self.waiting
            .iter()
            .map(|pending| pending.branch.priority)
            .min()
    }
}

#[derive(Default)]
struct Search {
    resources: BTreeMap<Request, Resource>,
    ready: Vec<Branch>,
    winner: Option<(Priority, DiscoveryCatalog)>,
    observations: BTreeMap<usize, (Priority, DiscoveryCatalog)>,
    diagnostics: Vec<CandidateDiagnostic>,
    order: usize,
    attempted: usize,
    exhausted: bool,
}

impl Search {
    fn inputs(
        &mut self,
        mut inputs: Vec<DiscoveryInput>,
        specs: &[FormatSpec],
        refresh: bool,
    ) -> bool {
        // Keep concrete metadata ahead of equally specific loader snapshots,
        // and prefer an explicit source's body over duplicate passive content.
        inputs.sort_by_cached_key(|input| {
            let specificity = if input.kind == DiscoveryInputKind::ObservedResource {
                specs
                    .iter()
                    .filter_map(|spec| spec.url_specificity(&input.url))
                    .min()
                    .unwrap_or(Specificity::Low)
            } else {
                input_specificity(input)
            };
            (
                specificity,
                input.kind != DiscoveryInputKind::Source,
                input.kind == DiscoveryInputKind::ObservedViewer,
            )
        });
        let previous = self.ready.len();
        for input in inputs {
            let specificity = input_specificity(&input);
            self.root(
                input,
                specs,
                Priority(specificity, 0, self.order, 0),
                refresh,
            );
        }
        self.ready.len() > previous
    }

    fn root(
        &mut self,
        input: DiscoveryInput,
        specs: &[FormatSpec],
        mut rank: Priority,
        refresh: bool,
    ) {
        let request = Request::new(&input.url);
        let entry = self.resources.entry(request.clone()).or_default();
        let changed = input
            .contents
            .as_ref()
            .is_some_and(|bytes| entry.supplied.as_ref().is_none_or(|old| **old != *bytes))
            && (refresh || entry.supplied.is_none());
        let retry = refresh
            && input.contents.is_none()
            && matches!(entry.state, State::Complete(_))
            && entry.supplied.is_none();
        if let Some(previous) = entry.root {
            rank.2 = previous.2;
            if rank >= previous && !changed && !retry {
                return;
            }
            rank = rank.min(previous);
        } else {
            self.order += 1;
        }
        entry.root = Some(rank);
        if changed || retry {
            if changed {
                entry.supplied = input.contents.map(Arc::new);
            }
            entry.state = State::Queued;
        }
        let observation = matches!(
            input.kind,
            DiscoveryInputKind::ObservedMetadata | DiscoveryInputKind::ObservedViewer
        );
        let recognized = specs
            .iter()
            .filter_map(|spec| spec.url_specificity(&input.url))
            .any(|strength| strength != Specificity::Low);
        for (format, spec) in specs.iter().enumerate() {
            let mut priority = Priority(rank.0, rank.1, rank.2, format);
            if input.kind == DiscoveryInputKind::ObservedResource {
                priority.0 = spec.url_specificity(&input.url).unwrap_or(rank.0);
            } else if input.kind == DiscoveryInputKind::Source && recognized {
                priority.0 = match spec.url_specificity(&input.url) {
                    Some(Specificity::High | Specificity::Medium) => Specificity::High,
                    _ => Specificity::Low,
                };
            }
            self.ready.push(Branch {
                spec: *spec,
                priority,
                parsed: ParsedResource::Follow(request.clone()),
                history: Vec::new(),
                canonical_uri: None,
                observation,
            });
        }
    }

    /// Advance every decoder that can run without a resource read.
    fn advance(&mut self) -> Result<(), DiscoveryError> {
        while let Some(mut branch) = self.ready.pop() {
            let result = branch.prepare();
            match result {
                Ok(Some((request, decoder, canonical))) => {
                    if branch.history.iter().any(|read| read.request == request) {
                        self.rejected(
                            branch.spec,
                            DiscoveryError::rejected(
                                RejectionKind::Failed,
                                "discovery followed the same resource twice",
                            ),
                        )?;
                        continue;
                    }
                    let entry = self.resources.entry(request.clone()).or_default();
                    if matches!(entry.state, State::Exhausted) {
                        continue;
                    }
                    if branch.observation && entry.supplied.is_none() {
                        continue;
                    }
                    branch.priority.1 += 1;
                    let pending = Pending {
                        branch,
                        decoder,
                        canonical,
                    };
                    if let State::Complete(result) = &entry.state {
                        if matches!(result, Ok(Read::NeedsAccess)) {
                            entry.waiting.push(pending);
                        } else {
                            let result = result.clone();
                            self.resume(request, pending, result)?;
                        }
                    } else {
                        entry.waiting.push(pending);
                    }
                }
                Ok(None) => self.accept(branch)?,
                Err(error) => self.rejected(branch.spec, error)?,
            }
        }
        Ok(())
    }

    fn accept(&mut self, branch: Branch) -> Result<(), DiscoveryError> {
        let priority = branch.priority;
        let result =
            branch
                .parsed
                .compile(branch.spec.name)
                .map(|catalog| match branch.canonical_uri {
                    Some(uri) => catalog.with_source_url(&uri),
                    None => catalog,
                });
        match result {
            Ok(catalog) if branch.observation => {
                if self
                    .observations
                    .get(&priority.2)
                    .is_none_or(|(old, _)| priority < *old)
                {
                    self.observations.insert(priority.2, (priority, catalog));
                }
            }
            Ok(catalog) => {
                if self.winner.as_ref().is_none_or(|(old, _)| priority < *old) {
                    self.winner = Some((priority, catalog));
                }
            }
            Err(error) => self.rejected(branch.spec, error)?,
        }
        Ok(())
    }

    fn rejected(&mut self, spec: FormatSpec, error: DiscoveryError) -> Result<(), DiscoveryError> {
        record_diagnostic(&mut self.diagnostics, spec, error)
    }

    fn resume(
        &mut self,
        request: Request,
        mut pending: Pending,
        result: Result<Read, Error>,
    ) -> Result<(), DiscoveryError> {
        let response = match result {
            Ok(Read::Response(response)) => Ok(response),
            Ok(Read::NeedsAccess) => unreachable!("blocked reads retain their continuations"),
            Err(error)
                if error.is_terminal() || matches!(error.cause(), Error::ResourceLimit { .. }) =>
            {
                return Err(DiscoveryError::Host(Box::new(error)));
            }
            Err(error) => Err(error),
        };
        let record = ReadResource { request, response };
        let parsed = pending
            .branch
            .decode(&record, pending.decoder, pending.canonical);
        pending.branch.history.push(record);
        match parsed {
            Ok(parsed) => {
                pending.branch.parsed = parsed;
                self.ready.push(pending.branch);
            }
            Err(error) => self.rejected(pending.branch.spec, error)?,
        }
        Ok(())
    }

    fn complete(
        &mut self,
        request: Request,
        result: Result<Read, Error>,
        specs: &[FormatSpec],
    ) -> Result<(), DiscoveryError> {
        let entry = self.resources.get_mut(&request).expect("registered read");
        entry.state = State::Complete(result.clone());
        if matches!(result, Ok(Read::NeedsAccess)) {
            return Ok(());
        }
        let depth = entry.priority().map_or(0, |rank| rank.1);
        let waiting = std::mem::take(&mut entry.waiting);
        for pending in waiting {
            self.resume(request.clone(), pending, result.clone())?;
        }
        if let Ok(Read::Response(response)) = result {
            self.frames(
                &ReadResource {
                    request,
                    response: Ok(response),
                },
                depth,
                specs,
            );
        }
        Ok(())
    }

    fn frames(&mut self, read: &ReadResource, depth: usize, specs: &[FormatSpec]) {
        let page = read.resource().expect("successful read");
        let base = crate::web_page::page_base(page);
        for source in crate::web_page::iframe_sources(page) {
            let uri = resolve_relative(&base, source);
            let supported = match url::Url::parse(&uri) {
                Ok(url) => matches!(url.scheme(), "http" | "https" | "file"),
                Err(url::ParseError::RelativeUrlWithoutBase) => url::Url::parse(&base).is_err(),
                Err(_) => false,
            };
            if supported {
                self.root(
                    DiscoveryInput::new(uri).with_kind(DiscoveryInputKind::ObservedDocument),
                    specs,
                    Priority(Specificity::Medium, depth, self.order, 0),
                    false,
                );
            }
        }
    }

    fn best(&self) -> Option<Priority> {
        self.winner
            .iter()
            .map(|(rank, _)| *rank)
            .chain(self.observations.values().map(|(rank, _)| *rank))
            .min()
    }

    fn settled(&self) -> bool {
        self.best().is_some_and(|best| {
            self.resources.values().all(|entry| {
                matches!(entry.state, State::Complete(_) | State::Exhausted)
                    || entry.priority().is_none_or(|rank| rank >= best)
            })
        })
    }

    fn catalog(mut self) -> DiscoveryCatalog {
        let best = self.best().expect("settled result");
        if self.winner.as_ref().is_some_and(|(rank, _)| *rank == best) {
            return self.winner.take().expect("winning catalog").1;
        }
        DiscoveryCatalog::new(
            self.observations
                .into_values()
                .flat_map(|(_, catalog)| catalog.into_entries()),
        )
    }

    /// Admit only peers of the strongest pending remote work. Local reads are
    /// independent of that bound, including supplied low-specificity documents.
    fn next(&self, local: bool) -> Option<Request> {
        let best = self
            .resources
            .values()
            .filter(|entry| !matches!(entry.state, State::Complete(_) | State::Exhausted))
            .filter_map(Resource::priority)
            .min()?;
        self.resources
            .iter()
            .filter(|(_, entry)| matches!(entry.state, State::Queued))
            .filter(|(_, entry)| entry.supplied.is_some() == local)
            .filter_map(|(request, entry)| entry.priority().map(|rank| (rank, request)))
            .filter(|(rank, _)| local || (rank.0, rank.1) <= (best.0, best.1))
            .min_by_key(|(rank, _)| *rank)
            .map(|(_, request)| request.clone())
    }

    fn admit(&mut self, request: &Request, limit: usize) -> bool {
        let entry = self.resources.get_mut(request).expect("queued read");
        if self.attempted >= limit {
            entry.waiting.clear();
            entry.state = State::Exhausted;
            self.exhausted = true;
            return false;
        }
        self.attempted += 1;
        entry.state = State::Reading;
        true
    }

    fn allow_blocked(&mut self) -> bool {
        let mut queued = false;
        for entry in self.resources.values_mut() {
            if !entry.interactive && matches!(entry.state, State::Complete(Ok(Read::NeedsAccess))) {
                entry.interactive = true;
                entry.state = State::Queued;
                queued = true;
            }
        }
        queued
    }
}

impl Branch {
    fn prepare(&mut self) -> Result<Option<(Request, Option<Decoder>, bool)>, DiscoveryError> {
        let mut parsed = std::mem::replace(
            &mut self.parsed,
            ParsedResource::Complete(DiscoveryCatalog::new([])),
        );
        parsed = strip_canonical_source(parsed, &mut self.canonical_uri);
        if let ParsedResource::Follow(request) = parsed {
            self.priority.0 = self.priority.0.min(
                self.spec
                    .url_specificity(&request.uri)
                    .unwrap_or(Specificity::Low),
            );
            parsed = self.spec.follow(request)?;
        }
        parsed = strip_canonical_source(parsed, &mut self.canonical_uri);
        match parsed {
            ParsedResource::Follow(request) => Ok(Some((request, None, false))),
            ParsedResource::FollowWith(request, decoder) => {
                Ok(Some((request, Some(decoder), true)))
            }
            ParsedResource::FollowIntermediate(request, decoder) => {
                Ok(Some((request, Some(decoder), false)))
            }
            parsed => {
                self.parsed = parsed;
                Ok(None)
            }
        }
    }

    fn decode(
        &mut self,
        record: &ReadResource,
        decoder: Option<Decoder>,
        canonical: bool,
    ) -> Result<ParsedResource, DiscoveryError> {
        let context = DiscoveryContext {
            history: &self.history,
        };
        let response = match &record.response {
            Ok(_) => record.resource().expect("response"),
            Err(error) => {
                return match self.spec.on_failure {
                    Some(handler) => handler(&context, &record.request, error),
                    None => Err(DiscoveryError::fetch_failed(error.clone())),
                };
            }
        };
        let resource = DiscoveryResource {
            context,
            ..response
        };
        if self.canonical_uri.as_deref() == Some(record.request.uri.as_str()) {
            self.canonical_uri = Some(resource.final_uri().to_owned());
        }
        if let Some(decode) = decoder {
            return decode(resource).map(|parsed| {
                if canonical {
                    ParsedResource::CanonicalSource {
                        uri: resource.final_uri().to_owned(),
                        parsed: Box::new(parsed),
                    }
                } else {
                    parsed
                }
            });
        }
        let (parsed, specificity) = parse_resource(self.spec.routes, resource)?;
        if let Some(specificity) = specificity {
            self.priority.0 = if specificity == Specificity::Low {
                specificity
            } else {
                self.priority.0.min(specificity)
            };
        }
        Ok(parsed)
    }
}

fn strip_canonical_source(
    mut parsed: ParsedResource,
    canonical: &mut Option<String>,
) -> ParsedResource {
    while let ParsedResource::CanonicalSource {
        uri,
        parsed: nested,
    } = parsed
    {
        *canonical = Some(uri);
        parsed = *nested;
    }
    parsed
}

fn input_specificity(input: &DiscoveryInput) -> Specificity {
    match input.kind {
        DiscoveryInputKind::Source => Specificity::High,
        DiscoveryInputKind::ObservedMetadata
        | DiscoveryInputKind::ObservedDocument
        | DiscoveryInputKind::ObservedViewer => Specificity::Medium,
        DiscoveryInputKind::ObservedResource => Specificity::Low,
    }
}

fn selectors(specs: &[FormatSpec]) -> Vec<String> {
    HtmlDocument::PAGE_QUERIES
        .iter()
        .copied()
        .chain(
            specs
                .iter()
                .flat_map(|spec| spec.html_queries.iter().copied()),
        )
        .chain(specs.iter().flat_map(|spec| {
            spec.routes
                .iter()
                .filter_map(|route| match route.matcher.pattern {
                    MatchPattern::Css(selector, _) => Some(selector),
                    _ => None,
                })
        }))
        .map(str::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

async fn parse<P, PFut>(
    bytes: Arc<Vec<u8>>,
    final_uri: Option<String>,
    selectors: Vec<String>,
    parse_html: &P,
) -> Result<Read, Error>
where
    P: Fn(HtmlQuery) -> PFut,
    PFut: std::future::Future<Output = Result<HtmlDocument, Error>>,
{
    let html = parse_html(HtmlQuery {
        source: String::from_utf8_lossy(&bytes).into_owned(),
        selectors,
    })
    .await?;
    Ok(Read::Response(Arc::new(ParsedResponse {
        bytes,
        final_uri,
        html,
    })))
}

/// Discover through matcher evidence and a shared table of bounded resource reads.
/// Supplied contents and accessible Host observations run before remote fallback.
/// Source catalogs precede viewer snapshots; snapshots keep loader-only siblings.
/// Hosts bound response sizes and stop I/O when the owning job is cancelled.
pub async fn discover<F, Fut, P, PFut, O, OFut>(
    inputs: Vec<DiscoveryInput>,
    specs: &[FormatSpec],
    limits: DiscoveryLimits,
    fetch: F,
    parse_html: P,
    observe: O,
) -> Result<DiscoveryCatalog, DiscoveryError>
where
    F: Fn(Request, Interaction) -> Fut,
    Fut: std::future::Future<Output = Result<crate::model::ResourceRead, Error>>,
    P: Fn(HtmlQuery) -> PFut,
    PFut: std::future::Future<Output = Result<HtmlDocument, Error>>,
    O: Fn(Interaction) -> OFut,
    OFut: std::future::Future<Output = Result<Vec<DiscoveryInput>, Error>>,
{
    let mut search = Search::default();
    search.inputs(inputs, specs, false);
    let selectors = selectors(specs);
    let mut active = FuturesUnordered::new();
    let mut observed = false;
    loop {
        search.advance()?;
        if let Some(request) = search.next(true) {
            if search.admit(&request, limits.resources) {
                let bytes = search.resources[&request]
                    .supplied
                    .clone()
                    .expect("local bytes");
                let result = parse(bytes, None, selectors.clone(), &parse_html).await;
                search.complete(request, result, specs)?;
            }
            continue;
        }
        if search.settled() {
            return Ok(search.catalog());
        }
        if !observed {
            let inputs = observe(Interaction::Forbidden)
                .await
                .map_err(|error| DiscoveryError::Host(Box::new(error)))?;
            observed = !search.inputs(inputs, specs, true);
            continue;
        }
        while active.len() < limits.concurrent.max(1) {
            let Some(request) = search.next(false) else {
                break;
            };
            if !search.admit(&request, limits.resources) {
                continue;
            }
            let interaction = if search.resources[&request].interactive {
                Interaction::Allowed
            } else {
                Interaction::Forbidden
            };
            let fetch = &fetch;
            let parse_html = &parse_html;
            let selectors = selectors.clone();
            active.push(
                async move {
                    let result = match fetch(request.clone(), interaction).await {
                        Ok(crate::model::ResourceRead::NeedsAccess { .. }) => Ok(Read::NeedsAccess),
                        Ok(crate::model::ResourceRead::Response { response }) => {
                            parse(
                                Arc::new(response.bytes),
                                response.final_uri,
                                selectors,
                                parse_html,
                            )
                            .await
                        }
                        Err(error) => Err(error),
                    };
                    (request, result)
                }
                .boxed_local(),
            );
        }
        if let Some((request, result)) = active.next().await {
            search.complete(request, result, specs)?;
            continue;
        }
        let inputs = observe(Interaction::Allowed)
            .await
            .map_err(|error| DiscoveryError::Host(Box::new(error)))?;
        if search.inputs(inputs, specs, true) {
            observed = false;
        } else if !search.allow_blocked() {
            return Err(if search.exhausted {
                DiscoveryError::ResourceLimitExceeded
            } else {
                DiscoveryError::NoCandidateAccepted {
                    diagnostics: search.diagnostics,
                }
            });
        }
    }
}
