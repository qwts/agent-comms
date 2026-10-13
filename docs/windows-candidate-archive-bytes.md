# Windows candidate archive bytes

Related to #164 and [desktop job proof](windows-desktop-job-proof.md).
This source-preparation correction is not desktop acceptance.

The fixed candidate commit/tree is unchanged. Git archive now explicitly uses
`core.autocrlf=false` and `core.eol=lf`; its canonical SHA-256 is
`1fd8baf80dc140cf6b4cc5e13f84ff3711230b50a93de9be6d34a2b3b93c4ba1`.
The retained earlier `85991a…` archive contained CRLF component bytes before
extraction. Regression tests reproduce that mismatch under ambient CRLF settings,
then verify canonical extraction and strict component tamper refusal. This fixes
source preparation; compiler and desktop acceptance remain unproven.


The previous full archive SHA-256 was
`85991a457b19c0f7367ca7a1d7fabbeadd7acb3bf15828f37594a5669c185ef6`.
The canonical archive is 4,106,240 bytes; the prior archive was 4,177,920 bytes.
The fixed source remains commit `cb50469ca0b6757c4ab860de582b9b140fc525a0`
and tree `34011276c3e651e6fd5bf7ba1e7c7f373053249e`.
Candidate-only archive configuration changes; old/new capacity archives and
production source, guards and deadlines remain unchanged.

The regression runs actual Git archive and tar extraction on the two fixed
component paths at its checkout HEAD, with ambient `core.autocrlf=true` and
`core.eol=crlf`. The original invocation must produce CRLF and fail the shared
production byte-hash check. The canonical invocation must reproduce Git blob
bytes exactly, and a one-byte mutation must still fail. Windows execution of
this new regression remains required; local portable checks are not a substitute.
