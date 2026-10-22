mod support;

use dezoomify::{dezoomify, model::*};
use futures::FutureExt;
use std::{cell::RefCell, collections::VecDeque, rc::Rc};
use support::MemoryHost;

fn image(width: u32, height: u32) -> Vec<JobInput> {
    vec![JobInput {
        url: "https://images.test/image.dzi".into(),
        contents: Some(format!(
            r#"<Image TileSize="256" Overlap="0" Format="jpg"><Size Width="{width}" Height="{height}"/></Image>"#,
        )),
        kind: None,
    }]
}

fn forbidden() -> Error {
    Error::HttpError {
        status: 403,
        retry_after_ms: None,
        preview: Some("access denied".into()),
        transport: ErrorTransport::Direct,
        failure: "original failure context".to_string().into(),
    }
    .resource("https://images.test/blocked.jpg", ResourceKind::Tile)
}

#[test]
fn concurrent_midstream_refusals_recover_once_and_retain_successful_tiles() {
    let host = MemoryHost::default();
    host.yield_tiles.set(true);
    host.failures.borrow_mut().extend([
        (8, VecDeque::from([forbidden(), forbidden()])),
        (9, VecDeque::from([forbidden()])),
        (10, VecDeque::from([forbidden()])),
        (11, VecDeque::from([forbidden()])),
    ]);
    let output =
        futures::executor::block_on(dezoomify(image(4096, 256), Options::default(), &host))
            .unwrap();
    assert_eq!(
        output.canvas,
        Some(Size {
            width: 4096,
            height: 256
        })
    );
    assert_eq!(host.acquired.borrow().len(), 16);
    let attempts = host.attempts.borrow();
    for tile in 0..8 {
        assert_eq!(attempts.iter().filter(|id| **id == tile).count(), 1);
    }
    assert_eq!(attempts.iter().filter(|id| **id == 8).count(), 3);
    assert_eq!(
        host.warnings.borrow().len(),
        2,
        "one quick probe and one shared cooldown"
    );
    assert!(host.clock_ms.get() >= 60_000);
    assert!(host.approvals.borrow().is_empty());
    assert_eq!(host.outputs.borrow().len(), 1);
}

#[test]
fn persistent_refusals_are_bounded_and_keep_the_original_error() {
    for (widespread, budget, expected_attempts, max_wait) in
        [(false, 3, 2, 1000), (true, 3, 3, 60_000), (true, 0, 1, 0)]
    {
        let host = MemoryHost::default();
        host.yield_tiles.set(true);
        host.failures
            .borrow_mut()
            .insert(8, VecDeque::from([forbidden(), forbidden(), forbidden()]));
        if widespread {
            host.failures
                .borrow_mut()
                .insert(9, VecDeque::from([forbidden()]));
        }
        let error = futures::executor::block_on(dezoomify(
            image(4096, 256),
            Options {
                max_retries: budget,
                interactive_retries: true,
                ..Default::default()
            },
            &host,
        ))
        .unwrap_err();
        assert_eq!(
            error,
            Error::TileFailed {
                tile: 8,
                attempts: expected_attempts,
                cause: Box::new(forbidden()),
            }
        );
        assert!(host.clock_ms.get() <= max_wait);
        assert!(host.outputs.borrow().is_empty());
        assert!(host.approvals.borrow().is_empty());
        assert_eq!(host.settled.get(), 1);
    }
}

#[test]
fn adaptive_pacing_finishes_an_image_behind_a_sliding_window_waf() {
    let host = MemoryHost::default();
    host.yield_tiles.set(true);
    let observations = Rc::new(RefCell::new(Vec::new()));
    let recorded = observations.clone();
    let mut window = VecDeque::new();
    *host.acquire_hook.borrow_mut() = Some(Box::new(move |_, now| {
        while window
            .front()
            .is_some_and(|start| now.saturating_sub(*start) >= 60_000)
        {
            window.pop_front();
        }
        let blocked = window.len() >= 300;
        window.push_back(now);
        recorded.borrow_mut().push((now, blocked));
        if blocked { Err(forbidden()) } else { Ok(()) }
    }));
    let result = futures::executor::block_on(dezoomify(
        image(8192, 8192),
        Options {
            max_concurrent: 6,
            initial_tile_interval_ms: 250,
            ..Default::default()
        },
        &host,
    ))
    .unwrap();
    assert_eq!(
        result.canvas,
        Some(Size {
            width: 8192,
            height: 8192
        })
    );
    assert_eq!(host.acquired.borrow().len(), 1024);
    let observations = observations.borrow();
    let first_refusal = observations
        .iter()
        .position(|(_, blocked)| *blocked)
        .expect("the rate ramps up to discover the limit");
    assert!(
        observations.iter().filter(|(_, blocked)| *blocked).count() <= 8,
        "one refusal cohort and two probes"
    );
    let recovered = observations
        .iter()
        .skip(first_refusal)
        .position(|(_, blocked)| !blocked)
        .unwrap()
        + first_refusal;
    assert!(
        observations[recovered..]
            .iter()
            .all(|(_, blocked)| !blocked),
        "the learned ceiling stays below the limit"
    );
    assert_eq!(host.outputs.borrow().len(), 1);
}

#[test]
fn cancellation_interrupts_both_pacing_and_cooldown() {
    for cooldown in [false, true] {
        let host = MemoryHost::default();
        host.cancel_on_sleep.set(true);
        if cooldown {
            host.failures.borrow_mut().insert(
                0,
                VecDeque::from([Error::HttpError {
                    status: 429,
                    retry_after_ms: Some(30_000),
                    preview: None,
                    transport: ErrorTransport::Direct,
                    failure: Failure::default(),
                }]),
            );
        }
        let result = futures::executor::block_on(dezoomify(
            image(4096, 256),
            Options {
                initial_tile_interval_ms: 250,
                ..Default::default()
            },
            &host,
        ));
        assert_eq!(result, Err(Error::Cancelled));
        assert!(host.outputs.borrow().is_empty());
        assert_eq!(host.settled.get(), 1);
    }
}

#[test]
fn retry_after_coalesces_per_origin_while_other_origins_continue() {
    let host = MemoryHost::default();
    host.yield_tiles.set(true);
    let observations = Rc::new(RefCell::new(Vec::new()));
    let recorded = observations.clone();
    let mut attempts = [0; 4];
    *host.acquire_hook.borrow_mut() = Some(Box::new(move |tile, now| {
        attempts[tile.index as usize] += 1;
        recorded.borrow_mut().push((tile.index, now));
        if tile.index.is_multiple_of(2) && attempts[tile.index as usize] == 1 {
            Err(Error::HttpError {
                status: 429,
                retry_after_ms: Some(if tile.index == 0 { 3000 } else { 7000 }),
                preview: None,
                transport: ErrorTransport::Direct,
                failure: Failure::default(),
            })
        } else {
            Ok(())
        }
    }));
    let input = JobInput {
        url: "https://images.test/tiles.yaml".into(),
        contents: Some(
            r#"
variables: [{ name: x, from: 0, to: 3 }]
url_template: "https://host{{x % 2}}.test/{{x}}.jpg"
x_template: "x * 256"
y_template: "0"
width: 1024
height: 256
"#
            .into(),
        ),
        kind: None,
    };
    futures::executor::block_on(dezoomify(vec![input], Options::default(), &host)).unwrap();
    let observations = observations.borrow();
    for tile in [1, 3] {
        assert_eq!(
            observations.iter().find(|(id, _)| *id == tile).unwrap().1,
            0
        );
    }
    for tile in [0, 2] {
        assert!(
            observations
                .iter()
                .filter(|(id, _)| *id == tile)
                .nth(1)
                .unwrap()
                .1
                >= 7000
        );
    }
    assert_eq!(
        host.warnings.borrow().len(),
        1,
        "one recovery episode for both refusals"
    );
    assert_eq!(host.acquired.borrow().len(), 4);
    assert_eq!(host.outputs.borrow().len(), 1);
}

#[test]
fn overlapping_waits_do_not_burst_with_arbitrary_clock_origins() {
    for origin in [0, 1_700_000_000_000] {
        let host = MemoryHost::default();
        host.manual_clock.set(true);
        host.time_origin_ms.set(origin);
        let starts = Rc::new(RefCell::new(Vec::new()));
        let recorded = starts.clone();
        *host.acquire_hook.borrow_mut() = Some(Box::new(move |_, now| {
            recorded.borrow_mut().push(now);
            Ok(())
        }));
        let mut job = Box::pin(dezoomify(
            image(1024, 256),
            Options {
                initial_tile_interval_ms: 250,
                ..Default::default()
            },
            &host,
        ));
        for now in [0, 250, 500, 750] {
            host.clock_ms.set(now);
            for (deadline, send) in host.pending_sleeps.take() {
                if deadline <= now {
                    send.send(()).unwrap();
                } else {
                    host.pending_sleeps.borrow_mut().push((deadline, send));
                }
            }
            let result = job.as_mut().now_or_never();
            if now == 750 {
                assert_eq!(
                    result.unwrap().unwrap().canvas,
                    Some(Size {
                        width: 1024,
                        height: 256
                    })
                );
            } else {
                assert!(result.is_none());
            }
            assert_eq!(
                &*starts.borrow(),
                &(0..=now / 250).map(|step| step * 250).collect::<Vec<_>>()
            );
        }
        assert_eq!(host.outputs.borrow().len(), 1);
    }
}
