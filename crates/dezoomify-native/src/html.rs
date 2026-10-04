//! Inert DOM parsing; also used by the core's deterministic test host.
use dezoomify::model::{Error, HtmlDocument, HtmlElement, HtmlQuery};
use scraper::{ElementRef, Html, Selector};

pub async fn parse_html(query: HtmlQuery) -> Result<HtmlDocument, Error> {
    let document = Html::parse_document(&query.source);
    let mut selections = Default::default();
    for selector in query.selectors {
        let parsed = Selector::parse(&selector)
            .map_err(|error| Error::BindingInvalidValue(error.to_string().into()))?;
        let elements = document
            .select(&parsed)
            .filter(|element| {
                element
                    .ancestors()
                    .chain(std::iter::once(**element))
                    .filter_map(ElementRef::wrap)
                    .all(|parent| !matches!(parent.value().name(), "template" | "noscript"))
            })
            .map(|element| HtmlElement {
                name: element.value().name().into(),
                attributes: element
                    .value()
                    .attrs()
                    .map(|(name, value)| (name.into(), value.into()))
                    .collect(),
                text: element
                    .descendants()
                    .filter(|node| !node.ancestors().any(|parent| parent.value().is_fragment()))
                    .filter_map(|node| node.value().as_text())
                    .map(|text| &**text)
                    .collect(),
            })
            .collect();
        std::collections::BTreeMap::insert(&mut selections, selector, elements);
    }
    Ok(HtmlDocument(selections))
}
