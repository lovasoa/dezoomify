//! `cargo xtask release verify`: ensure a frozen plan has all expected artifacts.

use super::common::{
    expected_artifact_name, load_capabilities, load_compatibility, load_config, load_targets,
    read_plan, validate_version, Plan,
};
use std::path::{Path, PathBuf};

pub(crate) fn verify_cmd(args: &[String]) -> Result<(), String> {
    let mut plan = None;
    let mut artifacts = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--plan" => {
                i += 1;
                plan = Some(PathBuf::from(args.get(i).ok_or("missing --plan <path>")?));
            }
            "--artifacts" => {
                i += 1;
                artifacts = Some(PathBuf::from(
                    args.get(i).ok_or("missing --artifacts <path>")?,
                ));
            }
            other => return Err(format!("unknown release verify arg '{other}'")),
        }
        i += 1;
    }
    let (Some(plan), Some(artifacts)) = (plan, artifacts) else {
        return Err(
            "usage: cargo xtask release verify --plan <path> --artifacts <path>".to_string(),
        );
    };
    release_verify(&read_plan(&plan)?, &artifacts)?;
    println!("release verify: ok");
    Ok(())
}

pub(crate) fn release_verify(plan: &Plan, artifacts: &Path) -> Result<(), String> {
    validate_version(&plan.version)?;
    let expected_tag = match plan.channel.as_str() {
        "rolling" => format!("rolling-v{}", plan.version),
        "stable" => format!("v{}", plan.version),
        _ => return Err(format!("unknown release channel {}", plan.channel)),
    };
    if plan.tag != expected_tag {
        return Err("plan tag does not match version".to_string());
    }
    let config = load_config()?;
    let compat = load_compatibility()?;
    let caps = load_capabilities()?;
    let targets = load_targets()?;
    if plan.version != super::common::app_version()?.0
        || plan.protocol.range != config.protocol.range
        || plan.protocol.min_peer != config.protocol.min_peer
        || plan.protocol.compatibility_current != compat.compatibility.current
        || plan.protocol.compatibility_n_minus_1 != compat.compatibility.n_minus_1
        || caps.protocol != plan.protocol.range
        || caps.capabilities != plan.capabilities
        || plan.targets.len() != targets.list.len()
        || plan
            .targets
            .iter()
            .zip(&targets.list)
            .any(|(planned, target)| planned.name != target.name || planned.os != target.os)
    {
        return Err(
            "plan disagrees with the repository release inventory; regenerate the plan".to_string(),
        );
    }
    for target in &plan.targets {
        let name = expected_artifact_name(&target.name, &plan.version)
            .ok_or_else(|| format!("target '{}' has no artifact name rule", target.name))?;
        let artifact = artifacts.join(&target.name).join(name);
        if !artifact.is_file() {
            return Err(format!(
                "target '{}' has no built artifact at {}",
                target.name,
                artifact.display()
            ));
        }
    }
    Ok(())
}
