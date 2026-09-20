'use strict';
/**
 * dsh-task-toast — HOST half.
 *
 * This module is the cordis plugin the loader mounts when the package is
 * installed: the `dsh.bundle.patch` layer (cordis.patch.yml) inserts this
 * package's row, and the loader requires this main entry for its `name` +
 * `apply` exports.
 *
 * The host half is deliberately EMPTY. The toast is pure client-side: it
 * watches the current session's `running` bit through the browser `sessions`
 * service and paints a plate into <body>. Nothing needs to happen on the host,
 * and a host half that registered a settings namespace would add a
 * cross-realm read-timing problem (the client must not read a preference
 * before the settings transport has served it) for no benefit in v1 — the
 * tunables are constants at the top of client.js.
 *
 * Keep the `name` + `apply` shape: the loader treats a module without a
 * callable `apply` as a failed plugin row.
 */
const NAME = 'dsh-task-toast';

function apply() {
  // Intentionally empty. See the module comment above.
}

module.exports = {
  name: NAME,
  apply,
};
