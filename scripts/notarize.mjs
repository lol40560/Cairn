import { notarize } from '@electron/notarize'

export default async function notarizeMac(context) {
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('Skipping macOS notarization: Apple credentials are not configured.')
    return
  }

  await notarize({
    appBundleId: context.packager.appInfo.id,
    appPath: `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  })
}
