#!/bin/sh
# The rewrite half of the Windows `make` shim. The `make.exe` beside this file
# (built from make-launcher.rs by setup.mjs) runs it with make's own arguments.
# Recipe and evidence: docs/ANDROID_TOOLCHAIN.md, "Session 5 (2026-11-18)".
#
# Why a shim at all: the Tauri CLI runs `Command::new("make")`, and Rust resolves
# only `.exe` on Windows — a `make.cmd` fails with "program not found" — while a
# shell-script `make` dies with OS error 216. So the shim is a real executable
# that hands the arguments to this script.
#
# Why the rewrite: OpenSSL's generated `makefile` hands libcrypto.a to `ar` in a
# single ~18 kB command line. The recipe shell truncates it, llvm-ar then reports
# the cut tail as its first argument (`error: cry: No such file or directory`,
# from `crypto/...`), and the build dies at `makefile:4427: libcrypto.a`. Run by
# hand from sh, the identical command succeeds — so keep it off that command
# line. llvm-ar expands `@file`, so an archive built from a response file is the
# same archive.
#
# Idempotent on purpose: a recipe that already names `@.objs-` is left alone, so
# the sub-makes that re-enter through this same shim do no work.
#
# One response file per recipe line, not per archive: `libcrypto.a` is archived by
# several consecutive `ar` calls (OpenSSL splits the object list to stay inside
# the limit), and naming the file after the archive made every one of them read
# the last chunk — a libcrypto.a with no `crypto/evp` objects at all, which links
# (undefined symbols are allowed) and then fails on the phone with
# `dlopen failed: cannot locate symbol "EVP_MAC_fetch"`.
GMAKE=${PM_GMAKE:-/c/Strawberry/c/bin/gmake.exe}
[ -x "$GMAKE" ] || GMAKE=gmake

patch_file() {
  f="$1"
  [ -f "$f" ] || return 0
  grep -q '$(AR) $(ARFLAGS) ' "$f" 2>/dev/null || return 0
  # Sanitise the response-file name: archives live in subdirectories too
  # (providers/libdefault.a), and a name containing "/" aborts the write-back.
  perl -e '
    my $f = $ARGV[0];
    open(my $in, "<", $f) or exit 0;
    my @out = <$in>; close $in;
    my $changed = 0;
    my %chunk;
    for my $l (@out) {
      next if $l =~ /\@\.objs-/;
      if ($l =~ /^\s*\$\(AR\) \$\(ARFLAGS\) (\S+) (\S.*?)\s*$/ && length($2) > 5000) {
        my ($ar,$rest)=($1,$2);
        (my $safe = $ar) =~ s|/|-|g;
        my $n = ++$chunk{$safe};
        my $rsp = ".objs-$safe-$n.txt";
        my @objs = split(/\s+/, $rest);
        if (open(my $fh, ">", $rsp)) {
          print $fh "$_\n" for @objs; close $fh;
          $l = "\t\$(AR) \$(ARFLAGS) $ar \@$rsp\n"; $changed = 1;
        }
      }
    }
    if ($changed) { open(my $o,">",$f) or exit 0; print $o @out; close $o; }
  ' "$f"
}

patch_file makefile
patch_file Makefile
exec "$GMAKE" "$@"
