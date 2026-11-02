//! Terminal selection from engine-supplied catalogs. EOF cancels the active job;
//! callers inspect `ended` after settlement to exit without reporting a failure.

use std::cell::Cell;
use std::io::{self, BufRead, IsTerminal as _, Write};

use dezoomify::model::{Catalog, CatalogEntry, Error, Image};
use dezoomify_native::{host::ImageSelection, NativeHost};

use crate::{arguments::Args, report::InteractiveProgress};

pub struct Interaction {
    pub enabled: bool,
    ended: Cell<bool>,
}

impl Interaction {
    pub fn new(args: &Args) -> Self {
        Self {
            enabled: can_interact(args, io::stdin().is_terminal(), io::stderr().is_terminal()),
            ended: Cell::new(false),
        }
    }

    pub fn ended(&self) -> bool {
        self.ended.get()
    }

    /// Call only in interactive mode. Read errors remain failures; EOF is recorded
    /// separately so a cancelled picker is distinguishable from other failures.
    #[allow(clippy::result_large_err)]
    pub fn input(&self) -> Result<Option<String>, Error> {
        self.read(prompt_line(
            &mut io::stdin().lock(),
            &mut io::stderr(),
            "Enter an URL or a path to a tiles.yaml file: ",
        ))
    }

    /// Install before starting the job. The Host decides whether selectors or a
    /// single option bypass each callback. Text answers finish before thumbnail I/O.
    pub fn register<'a>(&'a self, host: &NativeHost<'a>, progress: &'a InteractiveProgress) {
        if !self.enabled {
            return;
        }
        host.on_choose_image(|catalog| {
            let index = progress.without_display(|| {
                self.read(pick_image(
                    &catalog,
                    &mut io::stdin().lock(),
                    &mut io::stderr(),
                ))?
                .ok_or(Error::Cancelled)
            })?;
            Ok(ImageSelection {
                answer: Box::pin(std::future::ready(Ok(index))),
                preview: Box::new(|_, _| {}),
            })
        });
        host.on_choose_level(|image| {
            let answer = progress.without_display(|| {
                self.read(pick_level(
                    &image,
                    &mut io::stdin().lock(),
                    &mut io::stderr(),
                ))?
                .ok_or(Error::Cancelled)
            });
            Box::pin(std::future::ready(answer))
        });
    }

    #[allow(clippy::result_large_err)]
    fn read<T>(&self, result: io::Result<Option<T>>) -> Result<Option<T>, Error> {
        let value = result.map_err(|error| Error::ChoiceFailed(error.to_string().into()))?;
        self.ended.set(value.is_none());
        Ok(value)
    }
}

fn can_interact(args: &Args, stdin_terminal: bool, stderr_terminal: bool) -> bool {
    !args.json && !args.is_bulk_mode() && stdin_terminal && stderr_terminal
}

fn prompt_line(
    input: &mut impl BufRead,
    output: &mut impl Write,
    prompt: &str,
) -> io::Result<Option<String>> {
    write!(output, "{prompt}")?;
    output.flush()?;
    let mut line = String::new();
    match input.read_line(&mut line)? {
        0 => Ok(None),
        _ => Ok(Some(line.trim().to_string())),
    }
}

/// Keep supplied order: the result indexes this catalog, including deferred entries.
fn pick_image(
    catalog: &Catalog,
    input: &mut impl BufRead,
    output: &mut impl Write,
) -> io::Result<Option<u32>> {
    writeln!(output, "Found the following images:")?;
    for (index, entry) in catalog.entries.iter().enumerate() {
        let title = match entry {
            CatalogEntry::Image(image) => &image.title,
            CatalogEntry::ImageRequest(image) => &image.title,
        };
        match title.as_deref().filter(|title| !title.trim().is_empty()) {
            Some(title) => writeln!(output, "{index:>2}. {title}")?,
            None => writeln!(output, "{index:>2}. Image {}", index + 1)?,
        }
    }
    prompt_index("image", catalog.entries.len(), input, output)
}

fn pick_level(
    image: &Image,
    input: &mut impl BufRead,
    output: &mut impl Write,
) -> io::Result<Option<u32>> {
    writeln!(output, "Found the following zoom levels:")?;
    for (index, level) in image.levels.iter().enumerate() {
        writeln!(output, "{index:>2}. {}", level.label)?;
    }
    prompt_index("level", image.levels.len(), input, output)
}

fn prompt_index(
    kind: &str,
    count: usize,
    input: &mut impl BufRead,
    output: &mut impl Write,
) -> io::Result<Option<u32>> {
    loop {
        let Some(line) = prompt_line(
            input,
            output,
            &format!("Which {kind} do you want to download? "),
        )?
        else {
            return Ok(None);
        };
        if let Ok(index) = line.parse::<u32>() {
            if (index as usize) < count {
                return Ok(Some(index));
            }
        }
        writeln!(output, "error: '{line}' is not a valid {kind} number")?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dezoomify_fixture_server::{start, temp_dir};
    use dezoomify_native::{JobOptions, OutputTarget};
    use std::cell::RefCell;

    #[test]
    fn only_human_terminal_runs_prompt() {
        let mut args = crate::arguments::parse(&[]).unwrap();
        assert!(can_interact(&args, true, true));
        assert!(!can_interact(&args, false, true));
        assert!(!can_interact(&args, true, false));
        args.json = true;
        assert!(!can_interact(&args, true, true));
        args.json = false;
        args.bulk = Some("images.txt".into());
        assert!(!can_interact(&args, true, true));
    }

    #[test]
    fn menus_download_the_selected_image_at_a_smaller_resolution() {
        let dir = temp_dir("cli-menu");
        let output = dir.join("selected.png");
        let input = RefCell::new(&b"999\nno\n1\n-1\n999\n8\n"[..]);
        let transcript = RefCell::new(Vec::new());
        let host = NativeHost::new(JobOptions {
            input_url: format!("{}/fixtures/deepzoom/catalog/viewer.html", start()),
            output: OutputTarget::File(output.clone()),
            max_retries: 0,
            ..Default::default()
        })
        .unwrap();
        host.on_choose_image(|catalog| {
            let index = pick_image(
                &catalog,
                &mut *input.borrow_mut(),
                &mut *transcript.borrow_mut(),
            )
            .unwrap()
            .unwrap();
            Ok(ImageSelection {
                answer: Box::pin(std::future::ready(Ok(index))),
                preview: Box::new(|_, _| panic!("text choices do not load thumbnails")),
            })
        });
        host.on_choose_level(|image| {
            let index = pick_level(
                &image,
                &mut *input.borrow_mut(),
                &mut *transcript.borrow_mut(),
            )
            .unwrap()
            .unwrap();
            Box::pin(std::future::ready(Ok(index)))
        });
        host.transport
            .block_on(dezoomify::dezoomify(
                host.inputs(),
                host.algorithm_options(),
                &host,
            ))
            .unwrap();
        let saved = image::open(&output).unwrap().to_rgb8();
        assert_eq!(saved.dimensions(), (256, 256));
        // The first catalog image is solid red; the second has four quadrants.
        let bottom_right = saved.get_pixel(255, 255).0;
        assert!(
            bottom_right[1] > 150,
            "selected the second image: {bottom_right:?}"
        );
        drop(host);
        let transcript = String::from_utf8(transcript.into_inner()).unwrap();
        assert!(transcript.contains("Found the following images:"));
        assert!(transcript.contains("Found the following zoom levels:"));
        assert!(transcript.contains("256 x   256 pixels"));
        assert!(transcript.contains("1 tiles"));
        assert!(transcript.contains("'999' is not a valid image number"));
        assert!(transcript.contains("'no' is not a valid image number"));
        assert!(transcript.contains("'-1' is not a valid level number"));
        assert!(transcript.contains("'999' is not a valid level number"));
    }

    #[test]
    fn deferred_images_have_titles_and_eof_is_not_a_number() {
        let catalog = Catalog {
            entries: vec![
                CatalogEntry::ImageRequest(dezoomify::model::ImageRequest {
                    title: Some("Page two".into()),
                    uri: "https://images.test/2/info.json".into(),
                    size: None,
                    preview: None,
                }),
                CatalogEntry::ImageRequest(dezoomify::model::ImageRequest {
                    title: None,
                    uri: "https://images.test/3/info.json".into(),
                    size: None,
                    preview: None,
                }),
            ],
        };
        let interaction = Interaction {
            enabled: true,
            ended: Cell::new(false),
        };
        let mut output = Vec::new();
        let answer = interaction
            .read(pick_image(&catalog, &mut &b""[..], &mut output))
            .unwrap();
        assert_eq!(answer, None);
        assert!(interaction.ended());
        let output = String::from_utf8(output).unwrap();
        assert!(output.contains("0. Page two"));
        assert!(output.contains("1. Image 2"));
        assert!(!output.contains("not a valid"));
    }
}
