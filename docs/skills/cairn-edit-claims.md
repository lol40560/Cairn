# Cairn edit claims skill

Use this protocol before an AI agent edits any project file through Cairn.

1. List active claims with `cairn:listEditClaims`.
2. For every file you intend to modify, look for an active claim owned by another actor.
3. If one exists, **do not write the file**. Send the user a collaboration message explaining the file, claim holder, and the work you planned; wait for direction.
4. If none exists, create a claim with `cairn:createEditClaim`, including your stable agent ID, display name, a short purpose, and the current file content as `baseContent`.
5. Renew the claim at least once every two minutes with `cairn:heartbeatEditClaim`. Claims expire after ten minutes without a heartbeat.
6. Finish the edit, then call `cairn:completeEditClaim`. If you stop without finishing, call `cairn:cancelEditClaim`.

Claims are advisory by default. A project may enable strict edit protection, in which case Cairn rejects a save that overlaps another active claim. Only the original claim holder or the project owner may release a claim.

Never overwrite a claimed file by bypassing this protocol. If a file changes after you claim it, reread it and ask the user to resolve the conflict before continuing.
