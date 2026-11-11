//! `cargo xtask release verify`: ensure a frozen plan has all expected artifacts.

use super::common::{
    expected_artifact_name, load_capabilities, load_targets, read_plan, stage_args,
    validate_version, Plan,
};
use std::path::Path;

pub(crate) fn verify_cmd(args: &[String]) -> Result<(), String> {
    let (plan, artifacts) = stage_args(args, "verify", "--artifacts")?;
    release_verify(&read_plan(plan)?, Path::new(artifacts))?;
    println!("release verify: ok");
    Ok(())
}

pub(crate) fn release_verify(plan: &Plan, artifacts: &Path) -> Result<(), String> {
    validate_version(&plan.version)?;
    if plan.tag != plan.version {
        return Err("plan tag does not match version".to_string());
    }
    let caps = load_capabilities()?;
    let targets = load_targets()?;
    if plan.commit != super::common::git_commit()?
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
    super::updater::manifest(plan, artifacts)?;
    Ok(())
}
