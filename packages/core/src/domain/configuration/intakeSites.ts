// Staging intake endpoints are injected at build time (see scripts/lib/buildEnv.js)
// and default to an empty string in public release builds. This keeps internal
// staging hosts out of the published `@flashcatcloud/browser-*` artifacts.
// Replaced at build time by replace-build-env / webpack DefinePlugin.
declare const __BUILD_ENV__INTAKE_SITE_STAGING__: string
declare const __BUILD_ENV__INTAKE_SITE_FED_STAGING__: string

export type Site = string

export const INTAKE_SITE_STAGING: Site = __BUILD_ENV__INTAKE_SITE_STAGING__
export const INTAKE_SITE_FED_STAGING: Site = __BUILD_ENV__INTAKE_SITE_FED_STAGING__
export const INTAKE_SITE_US1: Site = 'browser.flashcat.cloud'
export const INTAKE_SITE_EU1: Site = 'browser.flashcat.cloud'
export const INTAKE_SITE_US1_FED: Site = 'browser.flashcat.cloud'

export const PCI_INTAKE_HOST_US1 = 'pci.browser-intake-datadoghq.com'
export const INTAKE_URL_PARAMETERS = ['ddsource', 'ddtags']
