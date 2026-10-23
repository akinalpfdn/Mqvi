//! Replaces the running hardware encoder without ending the share over the session it holds.
//!
//! A rebuild (a new VBV, a new size, an encoder that ignored a keyframe request) builds the next MFT
//! while the current one still runs. Consumer GPUs cap concurrent encoder sessions — NVIDIA allows 3
//! to 8 depending on the driver — and other apps hold some of them (OBS, Instant Replay). A share
//! that started on the last free session would die at its first rebuild, so a refused build frees
//! the running encoder and tries once more.

use anyhow::Result;

/// The encoder to run next. `build` is told whether `old` still runs: it is tried beside `old`
/// first, then alone once `old` is dropped. Only a failure of that second try is an error, and by
/// then `old` is gone.
pub fn replace<E>(old: E, mut build: impl FnMut(bool) -> Result<E>) -> Result<E> {
    match build(true) {
        Ok(new) => {
            drop(old);
            Ok(new)
        }
        Err(_) => {
            // No cause here: create_hw_encoder has already logged each refusal with its own.
            log::warn!(
                "a new encoder would not start beside the running one; freeing it and trying again"
            );
            drop(old);
            build(false)
                .map_err(|e| e.context("no new encoder even after the running one was freed"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;

    /// A GPU that allows `limit` encoder sessions at once.
    struct Gpu {
        limit: u32,
        open: Rc<Cell<u32>>,
    }

    /// One encoder, holding a session until it is dropped.
    struct Session(Rc<Cell<u32>>);

    impl Drop for Session {
        fn drop(&mut self) {
            self.0.set(self.0.get() - 1);
        }
    }

    impl Gpu {
        fn new(limit: u32) -> Self {
            Self { limit, open: Rc::new(Cell::new(0)) }
        }

        fn start(&self) -> Result<Session> {
            if self.open.get() >= self.limit {
                anyhow::bail!("no free session");
            }
            self.open.set(self.open.get() + 1);
            Ok(Session(self.open.clone()))
        }
    }

    #[test]
    fn should_build_the_new_encoder_while_the_old_one_still_runs() {
        let gpu = Gpu::new(2);
        let old = gpu.start().unwrap();
        let mut open_at_build = Vec::new();

        let new = replace(old, |_| {
            open_at_build.push(gpu.open.get());
            gpu.start()
        });

        assert!(new.is_ok());
        assert_eq!(open_at_build, [1], "built once, with the old encoder still running");
        assert_eq!(gpu.open.get(), 1, "the old encoder is released once the new one runs");
    }

    #[test]
    fn should_free_the_old_encoder_and_retry_when_it_holds_the_last_session() {
        let gpu = Gpu::new(1);
        let old = gpu.start().unwrap();
        let mut beside = Vec::new();

        let new = replace(old, |b| {
            beside.push(b);
            gpu.start()
        });

        assert!(new.is_ok());
        assert_eq!(beside, [true, false]);
        assert_eq!(gpu.open.get(), 1);
    }

    #[test]
    fn should_fail_when_no_encoder_starts_even_alone() {
        let gpu = Gpu::new(1);
        let old = gpu.start().unwrap();

        let new = replace(old, |_| -> Result<Session> { anyhow::bail!("the driver reset") });

        assert!(new.is_err());
        assert_eq!(gpu.open.get(), 0, "the old encoder was freed for the second try");
    }
}
