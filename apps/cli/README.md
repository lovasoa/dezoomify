# Command-line application

The terminal product makes Dezoomify usable from scripts and for batches of
image addresses. It adds command-line options, terminal interaction, and progress
reporting to the [native runtime](../../crates/dezoomify-native/).

Image discovery and download policy come from the [shared Rust algorithm](../../crates/dezoomify/).
The [desktop app](../desktop/) uses the same native saving capabilities through
a graphical interface. See the [CLI guide](../../docs/user/command-line.md) for use.
