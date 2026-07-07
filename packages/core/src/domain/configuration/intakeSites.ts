export type Site = string

// Internal staging intake host. Public https domain (no internal IP / cleartext
// endpoint), consistent with the native SDKs: Android FlashcatSite.STAGING and
// iOS FlashcatSite.staging both map staging to `jira.flashcat.cloud`.
export const INTAKE_SITE_STAGING: Site = 'jira.flashcat.cloud'
export const INTAKE_SITE_FED_STAGING: Site = 'jira.flashcat.cloud'
export const INTAKE_SITE_US1: Site = 'browser.flashcat.cloud'
export const INTAKE_SITE_EU1: Site = 'browser.flashcat.cloud'
export const INTAKE_SITE_US1_FED: Site = 'browser.flashcat.cloud'

export const PCI_INTAKE_HOST_US1 = 'pci.browser-intake-datadoghq.com'
export const INTAKE_URL_PARAMETERS = ['ddsource', 'ddtags']
