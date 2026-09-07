//! WMTS capabilities XML parsing.
//!
//! Split from `wmts/mod.rs` (todo 4.1): this module owns the namespace-blind
//! XML tree (`XmlElement`) plus small text helpers. Tile-matrix math lives in
//! `tilematrix`, layer selection and level planning in `layer`.

use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;

use crate::core::DiscoveryError;

#[derive(Debug)]
pub(crate) struct XmlElement {
    pub(crate) name: String,
    pub(crate) attributes: Vec<XmlAttribute>,
    pub(crate) children: Vec<XmlElement>,
    pub(crate) text: String,
}

#[derive(Debug)]
pub(crate) struct XmlAttribute {
    pub(crate) name: String,
    pub(crate) value: String,
}

pub(crate) fn parse_document(bytes: &[u8]) -> Result<XmlElement, DiscoveryError> {
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut root = None;
    let mut stack = Vec::new();

    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| DiscoveryError::Session(format!("invalid WMTS XML: {error}")))?;
        match event {
            Event::Start(start) => stack.push(element_from_start(&start)?),
            Event::Empty(start) => {
                append_element(&mut root, &mut stack, element_from_start(&start)?)?;
            }
            Event::End(_) => {
                let element = stack.pop().ok_or_else(|| {
                    DiscoveryError::Session("invalid WMTS XML: unmatched closing element".into())
                })?;
                append_element(&mut root, &mut stack, element)?;
            }
            Event::Text(text) => {
                let unescaped = quick_xml::escape::unescape(&text).map_err(|error| {
                    DiscoveryError::Session(format!("invalid WMTS text escape: {error}"))
                })?;
                append_text(&mut stack, unescaped.as_ref())?;
            }
            Event::CData(text) => {
                append_text(&mut stack, &text)?;
            }
            Event::GeneralRef(reference) => {
                let escaped = format!("&{};", reference.as_ref());
                let unescaped = quick_xml::escape::unescape(&escaped).map_err(|error| {
                    DiscoveryError::Session(format!("invalid WMTS reference: {error}"))
                })?;
                append_text(&mut stack, unescaped.as_ref())?;
            }
            Event::Eof => break,
            Event::Decl(_) | Event::PI(_) | Event::Comment(_) | Event::DocType(_) => {}
        }
        buffer.clear();
    }

    if !stack.is_empty() {
        return Err(DiscoveryError::Session(
            "invalid WMTS XML: unclosed element".into(),
        ));
    }
    root.ok_or_else(|| DiscoveryError::Session("invalid WMTS XML: no document element".into()))
}

fn element_from_start(start: &BytesStart<'_>) -> Result<XmlElement, DiscoveryError> {
    let name = start.local_name().into_inner().to_string();
    let mut attributes = Vec::new();
    for attribute in start.attributes() {
        let attribute = attribute.map_err(|error| {
            DiscoveryError::Session(format!("invalid WMTS XML attribute: {error}"))
        })?;
        let name = attribute.key.local_name().into_inner().to_string();
        let value = quick_xml::escape::unescape(&attribute.value)
            .map_err(|error| {
                DiscoveryError::Session(format!("invalid WMTS XML attribute value: {error}"))
            })?
            .into_owned();
        attributes.push(XmlAttribute { name, value });
    }
    Ok(XmlElement {
        name,
        attributes,
        children: Vec::new(),
        text: String::new(),
    })
}

// 6.1: `stack` must stay `&mut Vec` (parents are pushed); the
// `&mut [T]` suggestion cannot push, so the lint stays allowed.
#[allow(clippy::ptr_arg)]
fn append_element(
    root: &mut Option<XmlElement>,
    stack: &mut Vec<XmlElement>,
    element: XmlElement,
) -> Result<(), DiscoveryError> {
    if let Some(parent) = stack.last_mut() {
        parent.children.push(element);
    } else if root.is_some() {
        return Err(DiscoveryError::Session(
            "invalid WMTS XML: multiple document elements".into(),
        ));
    } else {
        *root = Some(element);
    }
    Ok(())
}

fn append_text(stack: &mut [XmlElement], text: &str) -> Result<(), DiscoveryError> {
    if let Some(element) = stack.last_mut() {
        element.text.push_str(text);
        Ok(())
    } else if text.trim().is_empty() {
        Ok(())
    } else {
        Err(DiscoveryError::Session(
            "invalid WMTS XML: text outside document element".into(),
        ))
    }
}

pub(crate) fn find_descendant<'a>(element: &'a XmlElement, name: &str) -> Option<&'a XmlElement> {
    if same_name(&element.name, name) {
        return Some(element);
    }
    element
        .children
        .iter()
        .find_map(|child| find_descendant(child, name))
}

pub(crate) fn descendants_named<'a>(element: &'a XmlElement, name: &str) -> Vec<&'a XmlElement> {
    let mut descendants = Vec::new();
    collect_descendants(element, name, &mut descendants);
    descendants
}

fn collect_descendants<'a>(
    element: &'a XmlElement,
    name: &str,
    descendants: &mut Vec<&'a XmlElement>,
) {
    if same_name(&element.name, name) {
        descendants.push(element);
    }
    for child in &element.children {
        collect_descendants(child, name, descendants);
    }
}

impl XmlElement {
    pub(crate) fn children_named<'a>(
        &'a self,
        name: &'a str,
    ) -> impl Iterator<Item = &'a XmlElement> + 'a {
        self.children
            .iter()
            .filter(move |child| same_name(&child.name, name))
    }

    pub(crate) fn attribute(&self, name: &str) -> Option<&str> {
        self.attributes
            .iter()
            .find(|attribute| same_name(&attribute.name, name))
            .map(|attribute| attribute.value.as_str())
    }
}

pub(crate) fn same_name(left: &str, right: &str) -> bool {
    left.eq_ignore_ascii_case(right)
}

pub(crate) fn text_content(element: &XmlElement) -> String {
    let mut text = element.text.clone();
    for child in &element.children {
        text.push_str(&text_content(child));
    }
    text.trim().to_owned()
}

pub(crate) fn required_text(
    element: &XmlElement,
    name: &str,
    label: &str,
) -> Result<String, DiscoveryError> {
    element
        .children_named(name)
        .next()
        .map(text_content)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| DiscoveryError::Session(format!("WMTS has no {label}")))
}
