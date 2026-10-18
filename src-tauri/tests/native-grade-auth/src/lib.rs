#![allow(dead_code)]
// Compile the real native modules without requiring a GUI or a Windows runtime.
#[path = "../../../src/data.rs"]
mod data;
#[path = "../../../src/grade_auth.rs"]
mod grade_auth;
#[path = "../../../src/grade_sync_store.rs"]
mod grade_sync_store;
