//! The four sealed routes the pairing window serves, one module each (§2.3):
//! the code-confirmed rendezvous, the §8.4 snapshot pull, the §9.1 upload and
//! the §6 sync exchange. Their shared admission checks live in [`common`].

pub(super) mod common;
pub(super) mod hello;
pub(super) mod snapshot;
pub(super) mod sync;
pub(super) mod upload;
