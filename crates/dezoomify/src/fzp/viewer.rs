//! Literal Lime declarations and document-relative configuration.

use std::sync::LazyLock;

use regex::Regex;

use crate::core::{
    CatalogPlan, DeferredResource, DiscoveryContext, DiscoveryError, DiscoveryResource,
    ParsedResource, Request, resolve_relative,
};
use crate::javascript::{
    captured, captured_literal, captures, function_body, inside_function, literal_regex,
    mask as javascript, property, property_exists,
};
use crate::web_page::{Script, scripts as page_scripts};

use super::invalid;

static LIME: LazyLock<Regex> = LazyLock::new(|| {
    literal_regex(
        r#"\b(?:window\.)?(lime(?:_\w+)?)\s*\(\s*(?:'([^']*)'|"([^"]*)")\s*(?:,\s*(?:'(fzp|xml)'|"(fzp|xml)"))?\s*(?:,\s*(?:'([^']*)'|"([^"]*)")\s*,\s*(?:'fzp'|"fzp"))?\s*(?:,\s*\{([^}]*)\})?\s*[,)]"#,
    )
});
static LOAD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\b(?:window\.)?Lime\.Viewer\.loadIn\s*\([^,]*,\s*\{([^}]*)\}"#).unwrap()
});
static PATH: LazyLock<Regex> = LazyLock::new(|| {
    literal_regex(r#"(?m)\bjime_vars\.ResourcePath\s*=\s*(?:'([^']*)'|"([^"]*)")\s*(?:;|$)"#)
});
static INDEX_PATH: LazyLock<Regex> = LazyLock::new(|| {
    literal_regex(r#"(?m)\bjime_vars\.IndexPath\s*=\s*(?:'([^']*)'|"([^"]*)")\s*(?:;|$)"#)
});

static DEPTH_RESOURCE: LazyLock<Regex> = LazyLock::new(|| {
    literal_regex(
        r#"(?m)\bjime_vars\.ResourcePath\s*=\s*lime_depth\[\s*(?:'dir'|"dir")\s*\]\s*\+\s*(?:'([^']*)'|"([^"]*)")\s*(?:;|$)"#,
    )
});
static DEPTH_INDEX: LazyLock<Regex> = LazyLock::new(|| {
    literal_regex(
        r#"(?m)\bjime_vars\.IndexPath\s*=\s*lime_depth\[\s*(?:'dir'|"dir")\s*\]\s*\+\s*(?:'([^']*)'|"([^"]*)")\s*(?:;|$)"#,
    )
});
static DEPTH_INIT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\blime_depth\s*=\s*limeGetScriptDepth\s*\(\s*\)").unwrap());
static PARAM_PATH: LazyLock<Regex> = LazyLock::new(|| {
    literal_regex(r#"\bparam\[\s*(?:'path'|"path")\s*\]\s*=\s*(?:'([^']*)'|"([^"]*)")\s*;"#)
});
static PARAM_INDEX: LazyLock<Regex> = LazyLock::new(|| {
    literal_regex(
        r#"\bparam\[\s*(?:'indexpath'|"indexpath")\s*\]\s*=\s*(?:'([^']*)'|"([^"]*)")\s*;"#,
    )
});
static INDEX_REFERENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\bindexpath\s*:\s*param\[\s*(?:'indexpath'|"indexpath")\s*\]"#).unwrap()
});
static PARAM_REFERENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?:\bpath|'path'|"path")\s*:\s*param\[\s*(?:'path'|"path")\s*\]"#).unwrap()
});
static PREVIEW: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?s)\b(?:window\.)?Lime\.Viewer\.init\s*\([^,]*,\s*\{[^;]*?\bpreview\s*:\s*\{([^}]*)\}"#,
    )
    .unwrap()
});

static WRAPPER_TYPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?:\btype|'type'|"type")\s*:\s*type\s*(?:,|$)"#).unwrap());

static DEFAULT_KIND: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\blime(?:2_common|_core)\s*\(\s*\w+\s*,\s*(?:'(fzp|xml)'|"(fzp|xml)")"#).unwrap()
});
static DELEGATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(lime2_common|lime_core)\s*\(").expect("constant Lime wrapper pattern")
});

struct Declaration {
    position: usize,
    wrapper: String,
    name: String,
    kind: String,
    path: Option<String>,
    resource_path: Option<String>,
    secondary: Option<(String, Option<String>)>,
    dynamic_path: bool,
}

fn declaration(text: &str) -> Option<Declaration> {
    let lime = captures(&LIME, text)
        .find(|c| !inside_function(text, c.get(0).unwrap().start()))
        .and_then(|c| {
            let kind = c
                .get(4)
                .or_else(|| c.get(5))
                .map_or("", |kind| kind.as_str())
                .to_owned();
            let options = c.get(8).map_or("", |options| options.as_str());
            let key = if kind == "xml" { "indexpath" } else { "path" };
            let parameter_path = property(options, key);
            Some(Declaration {
                position: c.get(0)?.start(),
                wrapper: c[1].to_owned(),
                name: captured_literal(&c, 2..4)?,
                dynamic_path: (property_exists(options, key) && parameter_path.is_none())
                    || (kind == "xml"
                        && property_exists(options, "path")
                        && property(options, "path").is_none())
                    || ["syncpath", "glasspath"].into_iter().any(|key| {
                        property_exists(options, key) && property(options, key).is_none()
                    }),
                path: parameter_path,
                resource_path: property(options, "path"),
                kind,
                secondary: captured_literal(&c, 6..8).map(|name| {
                    (
                        name,
                        property(options, "syncpath").or_else(|| property(options, "glasspath")),
                    )
                }),
            })
        });
    let load = captures(&LOAD, text)
        .filter(|c| !inside_function(text, c.get(0).unwrap().start()))
        .find_map(|captures| {
            let options = &captures[1];
            let name = property(options, "name")?;
            let kind = property(options, "type")?;
            matches!(kind.as_str(), "fzp" | "xml").then(|| Declaration {
                position: captures.get(0).unwrap().start(),
                wrapper: String::new(),
                name,
                kind,
                path: property(options, "path"),
                resource_path: None,
                secondary: None,
                dynamic_path: property_exists(options, "path")
                    && property(options, "path").is_none(),
            })
        });
    lime.into_iter()
        .chain(load)
        .min_by_key(|declaration| declaration.position)
}

fn configured_path(
    text: &str,
    kind: &str,
    document: DiscoveryResource<'_>,
    wrapper: &str,
) -> Option<String> {
    let body = function_body(text, wrapper);
    body.and_then(|body| {
        captures(&LOAD, body).find_map(|c| {
            captures(&WRAPPER_TYPE, &c[1]).next().and_then(|_| {
                property(&c[1], "path").or_else(|| {
                    captures(&PARAM_REFERENCE, &c[1]).next()?;
                    if kind == "xml" {
                        preview_path(body, kind, true)
                    } else {
                        None
                    }
                    .or_else(|| captured(&PARAM_PATH, body))
                })
            })
        })
    })
    .or_else(|| jime_path(text, kind, document, wrapper))
    .or_else(|| {
        captures(&LOAD, text)
            .filter(|c| !inside_function(text, c.get(0).unwrap().start()))
            .find_map(|c| {
                (property(&c[1], "type").as_deref() == Some(kind))
                    .then(|| property(&c[1], "path"))
                    .flatten()
            })
    })
    .or_else(|| preview_path(body.unwrap_or(text), kind, body.is_some()))
}

fn preview_path(text: &str, kind: &str, selected_wrapper: bool) -> Option<String> {
    captures(&PREVIEW, text)
        .filter(|c| selected_wrapper || !inside_function(text, c.get(0).unwrap().start()))
        .find_map(|c| {
            property(
                &c[1],
                if kind == "fzp" {
                    "resourcepath"
                } else {
                    "indexpath"
                },
            )
            .or_else(|| {
                (kind == "xml" && captures(&INDEX_REFERENCE, &c[1]).next().is_some())
                    .then(|| captured(&PARAM_INDEX, text))
                    .flatten()
            })
        })
}

// The verified Lime 2 helper derives dir from the original script src string.
// This recognizes its two path assignments without executing JavaScript.
fn jime_path(
    text: &str,
    kind: &str,
    document: DiscoveryResource<'_>,
    wrapper: &str,
) -> Option<String> {
    let body = function_body(text, wrapper);
    let scope = body
        .and_then(|body| {
            let call = captures(&DELEGATE, body).next()?;
            function_body(text, &call[1])
        })
        .or(body)
        .unwrap_or(text);
    let path = |regex: &Regex| captured(regex, scope).or_else(|| captured(regex, text));
    path(if kind == "fzp" { &PATH } else { &INDEX_PATH }).or_else(|| {
        let suffix = path(if kind == "fzp" {
            &DEPTH_RESOURCE
        } else {
            &DEPTH_INDEX
        })?;
        captures(&DEPTH_INIT, text).next()?;
        page_scripts(document)
            .into_iter()
            .filter_map(|script| script.source)
            .find_map(|src| {
                src.find("limescripts")?;
                let end = src
                    .rfind("../")
                    .map(|i| i + 3)
                    .or_else(|| src.starts_with("./").then_some(2))
                    .unwrap_or(0);
                if end == 0 && !src.starts_with("limescripts") {
                    return None;
                }
                let prefix = &src[..end];
                prefix
                    .bytes()
                    .all(|b| matches!(b, b'.' | b'/'))
                    .then(|| format!("{prefix}{suffix}"))
            })
    })
}

pub(super) fn recognizes(resource: DiscoveryResource<'_>) -> bool {
    configuration(resource, &[]).is_some()
}

pub(super) fn resource_base(resource: DiscoveryResource<'_>) -> Option<String> {
    let history = resource.context().resources().collect::<Vec<_>>();
    let viewer = history.iter().find(|r| recognizes(**r))?;
    let (declaration, text, base) = configuration(*viewer, &history)?;
    let path = if declaration.kind == "xml" {
        declaration
            .resource_path
            .or_else(|| jime_path(&text, "fzp", *viewer, &declaration.wrapper))
            .or_else(|| {
                let body = function_body(&text, &declaration.wrapper);
                preview_path(body.unwrap_or(&text), "fzp", body.is_some())
            })
    } else {
        configured_path(&text, "fzp", *viewer, &declaration.wrapper)
    };
    path.map(|path| resolve_relative(&base, &directory(&path)))
}

fn directory(path: &str) -> String {
    if path.is_empty() {
        "./".into()
    } else {
        format!("{}/", path.trim_end_matches('/'))
    }
}

fn script_source(script: &Script, resources: &[DiscoveryResource<'_>]) -> Option<String> {
    if let Some(src) = &script.source {
        let uri = resolve_relative(&script.fetch_base, src);
        resources
            .iter()
            .find(|r| r.uri() == uri)
            .map(|r| javascript(&r.text_lossy()))
    } else {
        Some(javascript(&script.body))
    }
}

fn configuration(
    document: DiscoveryResource<'_>,
    resources: &[DiscoveryResource<'_>],
) -> Option<(Declaration, String, String)> {
    let sources = page_scripts(document)
        .into_iter()
        .filter_map(|script| script_source(&script, resources).map(|source| (script.base, source)))
        .collect::<Vec<_>>();
    let base = sources
        .iter()
        .find(|(_, source)| declaration(source).is_some())?
        .0
        .clone();
    let mut text = sources
        .into_iter()
        .map(|(_, source)| source)
        .collect::<Vec<_>>()
        .join("\n");
    let declaration = declaration(&text)?;
    text.truncate(declaration.position);
    Some((declaration, text, base))
}

fn resource_name(name: &str) -> Result<(), DiscoveryError> {
    if name.is_empty()
        || name
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || name.contains(['\\', ':', '?', '#', '%'])
    {
        return Err(invalid(format!("unsupported resource name {name:?}")));
    }
    Ok(())
}

pub(super) fn image_uri(base: &str, name: &str) -> Result<String, DiscoveryError> {
    resource_name(name)?;
    Ok(resolve_relative(
        &directory(base),
        &format!("{name}/root.xml"),
    ))
}

pub(super) fn decode(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    let mut resources = resource.context().resources().collect::<Vec<_>>();
    resources.push(resource);
    navigate(&resources, |uri| {
        uri == resource.uri() || resource.context().has_visited(uri)
    })
    .map_err(|error| {
        resource
            .context()
            .failures()
            .next_back()
            .map_or(error, |cause| DiscoveryError::fetch_failed(cause.clone()))
    })
}

fn navigate(
    resources: &[DiscoveryResource<'_>],
    visited: impl Fn(&str) -> bool,
) -> Result<ParsedResource, DiscoveryError> {
    let document = *resources
        .iter()
        .find(|r| recognizes(**r))
        .ok_or_else(|| invalid("no supported literal Lime declaration"))?;
    if let Some(request) = scripts(document, resources).find(|r| !visited(&r.uri)) {
        return Ok(ParsedResource::Follow(request));
    }
    let (declaration, text, document_base) = configuration(document, resources)
        .ok_or_else(|| invalid("no supported literal Lime declaration"))?;
    let Declaration {
        wrapper,
        name,
        mut kind,
        path: declared_path,
        secondary,
        dynamic_path,
        ..
    } = declaration;
    if dynamic_path {
        return Err(invalid("unsupported dynamic Lime path"));
    }
    if kind.is_empty() {
        let body = function_body(&text, &wrapper)
            .ok_or_else(|| invalid("Lime wrapper has no supported format declaration"))?;
        kind = captured(&DEFAULT_KIND, body)
            .ok_or_else(|| invalid("Lime wrapper has no supported format declaration"))?;
    }
    let base = declared_path.or_else(|| configured_path(&text, &kind, document, &wrapper));
    if let Some(base) = base {
        resource_name(&name)?;
        let base = resolve_relative(&document_base, &directory(&base));
        if kind == "fzp"
            && let Some((secondary, secondary_path)) = secondary
        {
            let second_base = secondary_path
                .map(|path| resolve_relative(&document_base, &directory(&path)))
                .unwrap_or_else(|| base.clone());
            let entries = [(name, base.clone()), (secondary, second_base)]
                .into_iter()
                .map(|(name, base)| {
                    Ok(DeferredResource {
                        uri: image_uri(&base, &name)?,
                        title: Some(name),
                        warnings: Vec::new(),
                    })
                })
                .collect::<Result<Vec<_>, DiscoveryError>>()?;
            return Ok(ParsedResource::Catalog(CatalogPlan::deferred(entries)));
        }
        let uri = if kind == "fzp" {
            image_uri(&base, &name)?
        } else {
            resolve_relative(&base, &format!("{name}.xml"))
        };
        return Ok(ParsedResource::Follow(Request::new(uri)));
    }
    Err(invalid(
        "Lime declaration has no supported resource/index path configuration",
    ))
}

fn scripts(
    document: DiscoveryResource<'_>,
    resources: &[DiscoveryResource<'_>],
) -> impl Iterator<Item = Request> {
    let mut requests = Vec::new();
    for script in page_scripts(document) {
        if let Some(src) = &script.source {
            requests.push(Request::new(resolve_relative(&script.fetch_base, src)));
        }
        if script_source(&script, resources).is_some_and(|source| declaration(&source).is_some()) {
            break;
        }
    }
    requests.into_iter()
}

/// Auxiliary script failures do not abort discovery; image/index failures do.
pub(super) fn failed_script(
    context: &DiscoveryContext<'_>,
    request: &Request,
    error: &crate::model::Error,
) -> Result<ParsedResource, DiscoveryError> {
    let resources = context.resources().collect::<Vec<_>>();
    for document in context.resources().filter(|r| recognizes(*r)) {
        if scripts(document, &resources).any(|r| r.uri == request.uri) {
            return navigate(&resources, |uri| {
                uri == request.uri || context.has_visited(uri)
            })
            .map_err(|_| DiscoveryError::fetch_failed(error.clone()));
        }
    }
    Err(DiscoveryError::fetch_failed(error.clone()))
}
