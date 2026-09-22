//! Pure discovery for Web Map Tile Service capabilities documents.

use crate::core::{DiscoveryCatalog, DiscoveryError, DiscoveryMatch, FormatSpec};

mod capabilities;
mod layer;
mod tilematrix;

pub const SPEC: FormatSpec = FormatSpec::new("wmts", &[DiscoveryMatch::Any.extract(catalog)])
    .with_display_name("WMTS")
    .recognizing(is_wmts_url, "not a WMTS capabilities URL")
    .preferring(|uri| uri.to_ascii_lowercase().contains("wmts"));

fn is_wmts_url(uri: &str) -> bool {
    uri.to_ascii_lowercase().contains("wmts")
}

fn catalog(url: &str, bytes: &[u8]) -> Result<DiscoveryCatalog, DiscoveryError> {
    let document = capabilities::parse_document(bytes)?;
    let context = layer::parse_context(url, &document)?;
    let levels = layer::build_levels(&context)?;
    if levels.is_empty() {
        return Err(DiscoveryError::Session("WMTS has no tile matrices".into()));
    }
    Ok(DiscoveryCatalog::ready(
        "wmts",
        Some(context.layer_name),
        levels,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Vec2d;
    use crate::core::{DiscoveredEntry, TileSource};

    #[test]
    fn namespaces_links_limits_and_wgs84_bounds_are_handled_together() {
        let xml = br#"
            <w:Capabilities xmlns:w="http://www.opengis.net/wmts/1.0"
                xmlns:o="http://www.opengis.net/ows/1.1">
              <w:Contents>
                <w:Layer>
                  <o:Identifier>linked-layer</o:Identifier>
                  <o:WGS84BoundingBox>
                    <o:LowerCorner>-10 -10</o:LowerCorner>
                    <o:UpperCorner>10 10</o:UpperCorner>
                  </o:WGS84BoundingBox>
                  <w:Format>image/png</w:Format>
                  <w:Style isDefault="true"><o:Identifier>default-style</o:Identifier></w:Style>
                  <w:TileMatrixSetLink>
                    <w:TileMatrixSet>selected</w:TileMatrixSet>
                    <w:TileMatrixSetLimits>
                      <w:TileMatrixLimits>
                        <o:TileMatrix>0</o:TileMatrix>
                        <w:MinTileRow>1</w:MinTileRow>
                        <w:MaxTileRow>1</w:MaxTileRow>
                        <w:MinTileCol>1</w:MinTileCol>
                        <w:MaxTileCol>1</w:MaxTileCol>
                      </w:TileMatrixLimits>
                    </w:TileMatrixSetLimits>
                  </w:TileMatrixSetLink>
                  <w:ResourceURL format="text/xml" resourceType="FeatureInfo" template="/feature/{TileRow}" />
                  <w:ResourceURL format="image/png" resourceType="tile"
                    template="tiles/{Style}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png" />
                </w:Layer>
                <w:TileMatrixSet>
                  <o:Identifier>wrong</o:Identifier>
                  <o:SupportedCRS>urn:ogc:def:crs:EPSG::3857</o:SupportedCRS>
                  <w:TileMatrix>
                    <o:Identifier>wrong-matrix</o:Identifier>
                    <w:ScaleDenominator>279541132.0143589</w:ScaleDenominator>
                    <w:TopLeftCorner>-20037508.342789248 20037508.342789248</w:TopLeftCorner>
                    <w:TileWidth>256</w:TileWidth><w:TileHeight>256</w:TileHeight>
                    <w:MatrixWidth>1</w:MatrixWidth><w:MatrixHeight>1</w:MatrixHeight>
                  </w:TileMatrix>
                </w:TileMatrixSet>
                <w:TileMatrixSet>
                  <o:Identifier>selected</o:Identifier>
                  <o:SupportedCRS>urn:ogc:def:crs:EPSG::3857</o:SupportedCRS>
                  <w:TileMatrix>
                    <o:Identifier>0</o:Identifier>
                    <w:ScaleDenominator>279541132.0143589</w:ScaleDenominator>
                    <w:TopLeftCorner>-20037508.342789248 20037508.342789248</w:TopLeftCorner>
                    <w:TileWidth>256</w:TileWidth><w:TileHeight>256</w:TileHeight>
                    <w:MatrixWidth>4</w:MatrixWidth><w:MatrixHeight>4</w:MatrixHeight>
                  </w:TileMatrix>
                </w:TileMatrixSet>
              </w:Contents>
            </w:Capabilities>
        "#;

        let catalog = catalog("https://example.test/wmts/capabilities.xml", xml).unwrap();
        let [DiscoveredEntry::Ready(image)] = catalog.entries() else {
            panic!("expected one ready image")
        };
        assert_eq!(image.title.as_deref(), Some("linked-layer"));
        let TileSource::Grid(grid) = &image.levels[0].source else {
            panic!("expected a known grid")
        };
        assert_eq!(grid.image_size(), Vec2d::square(256));
        assert_eq!(
            grid.tiles_row_major().next().unwrap().unwrap().request.uri,
            "https://example.test/wmts/tiles/default-style/selected/0/1/1.png"
        );
    }

    #[test]
    fn matrix_dimensions_are_used_without_a_layer_bounding_box() {
        let xml = br#"
            <Capabilities><Contents><Layer><Identifier>whole-matrix</Identifier>
              <Format>image/jpeg</Format><ResourceURL resourceType="tile" format="image/jpeg"
                template="tiles/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.jpg" />
            </Layer><TileMatrixSet><Identifier>set</Identifier><SupportedCRS>EPSG:3857</SupportedCRS>
              <TileMatrix><Identifier>level</Identifier><ScaleDenominator>1</ScaleDenominator>
                <TopLeftCorner>0 0</TopLeftCorner><TileWidth>128</TileWidth><TileHeight>256</TileHeight>
                <MatrixWidth>2</MatrixWidth><MatrixHeight>3</MatrixHeight></TileMatrix>
            </TileMatrixSet></Contents></Capabilities>
        "#;

        let catalog = catalog("https://example.test/wmts/capabilities.xml", xml).unwrap();
        let [DiscoveredEntry::Ready(image)] = catalog.entries() else {
            panic!("expected one ready image")
        };
        let TileSource::Grid(grid) = &image.levels[0].source else {
            panic!("expected a known grid")
        };
        assert_eq!(grid.image_size(), Vec2d { x: 256, y: 768 });
        assert_eq!(grid.count(), 6);
        assert_eq!(
            grid.tiles_row_major().last().unwrap().unwrap().request.uri,
            "https://example.test/wmts/tiles/set/level/2/1.jpg"
        );
    }

    #[test]
    fn a_non_default_style_is_kept_in_relative_tile_urls() {
        let xml = br#"
            <Capabilities><Contents><Layer><Identifier>styled</Identifier>
              <Style isDefault="false"><Identifier>night</Identifier></Style>
              <ResourceURL resourceType="tile" template="tiles/{Style}/{TileMatrix}/{TileRow}/{TileCol}.jpg" />
            </Layer><TileMatrixSet><Identifier>set</Identifier><SupportedCRS>EPSG:3857</SupportedCRS>
              <TileMatrix><Identifier>0</Identifier><ScaleDenominator>1</ScaleDenominator>
                <TopLeftCorner>0 0</TopLeftCorner><TileWidth>256</TileWidth><TileHeight>256</TileHeight>
                <MatrixWidth>1</MatrixWidth><MatrixHeight>1</MatrixHeight></TileMatrix>
            </TileMatrixSet></Contents></Capabilities>
        "#;

        let catalog = catalog("https://example.test/wmts/capabilities.xml", xml).unwrap();
        let [DiscoveredEntry::Ready(image)] = catalog.entries() else {
            panic!("expected one ready image")
        };
        let TileSource::Grid(grid) = &image.levels[0].source else {
            panic!("expected a known grid")
        };
        assert_eq!(
            grid.tiles_row_major().next().unwrap().unwrap().request.uri,
            "https://example.test/wmts/tiles/night/0/0/0.jpg"
        );
    }

    #[test]
    fn unknown_template_placeholders_are_rejected() {
        let xml = br#"
            <Capabilities><Contents><Layer><Identifier>invalid-template</Identifier>
              <ResourceURL resourceType="tile" template="tiles/{Time}/{TileRow}/{TileCol}.jpg" />
            </Layer><TileMatrixSet><Identifier>set</Identifier><SupportedCRS>EPSG:3857</SupportedCRS>
              <TileMatrix><Identifier>0</Identifier><ScaleDenominator>1</ScaleDenominator>
                <TopLeftCorner>0 0</TopLeftCorner><TileWidth>256</TileWidth><TileHeight>256</TileHeight>
                <MatrixWidth>1</MatrixWidth><MatrixHeight>1</MatrixHeight></TileMatrix>
            </TileMatrixSet></Contents></Capabilities>
        "#;
        assert!(catalog("https://example.test/wmts/capabilities.xml", xml).is_err());
    }

    #[test]
    fn unknown_bounding_box_crs_is_rejected() {
        let xml = br#"
            <Capabilities><Contents><Layer><Identifier>unknown-crs</Identifier>
              <BoundingBox crs="EPSG:3413"><LowerCorner>0 0</LowerCorner><UpperCorner>1 1</UpperCorner></BoundingBox>
              <ResourceURL resourceType="tile" template="tiles/{TileMatrix}/{TileRow}/{TileCol}.jpg" />
            </Layer><TileMatrixSet><Identifier>set</Identifier><SupportedCRS>EPSG:3857</SupportedCRS>
              <TileMatrix><Identifier>0</Identifier><ScaleDenominator>1</ScaleDenominator>
                <TopLeftCorner>0 0</TopLeftCorner><TileWidth>256</TileWidth><TileHeight>256</TileHeight>
                <MatrixWidth>1</MatrixWidth><MatrixHeight>1</MatrixHeight></TileMatrix>
            </TileMatrixSet></Contents></Capabilities>
        "#;
        assert!(catalog("https://example.test/wmts/capabilities.xml", xml).is_err());
    }
}
