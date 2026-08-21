import { defineGlobal } from '../boot/global'
import { makeRumLegacyPublicApi } from '../boot/publicApi'

/*
 * Deliberately not an extension of Window. A spec elsewhere in the repository augments the global
 * Window with its own type for this property, and the repository-wide typecheck compiles them
 * together, so extending it here would be two declarations of one global disagreeing. All this
 * needs is somewhere to put the api.
 */
interface GlobalWithRum {
  FC_RUM?: unknown
}

/*
 * The whole evaluation is guarded. The loader snippet routes every browser without fetch and
 * Promise here, which includes engines below even this build's floor (IE6 to IE8, and their
 * document modes). On those, collecting nothing is acceptable; an uncaught error thrown into the
 * customer's page while the script evaluates is not. If construction fails, the loader's stub is
 * left in place, where queued calls stay harmless.
 *
 * A syntax-level incompatibility cannot be caught here; the ES3 property-name scan in
 * check-es5-compatibility.js covers that side.
 */
let api: ReturnType<typeof makeRumLegacyPublicApi> | undefined
try {
  api = makeRumLegacyPublicApi()
  defineGlobal(window as unknown as GlobalWithRum, 'FC_RUM', api)
} catch {
  // Deliberately silent: there may be no console to warn into, and warning is not worth risking.
}

export const flashcatRumLegacy = api
