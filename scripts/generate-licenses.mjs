import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getProductionLicenseInventory, renderThirdPartyNotices } from './legal-utils.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const noticesPath = path.join(projectRoot, 'THIRD_PARTY_NOTICES.md')
const output = renderThirdPartyNotices(await getProductionLicenseInventory(projectRoot))

await writeFile(noticesPath, output, 'utf8')
console.info(`已生成 ${path.basename(noticesPath)}。`)
