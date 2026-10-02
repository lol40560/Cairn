import { describe, expect, it } from 'vitest'

import { detectLanguage } from './detect-language'

describe('detectLanguage', () => {
  it('识别常见源码与配置文件扩展名', () => {
    expect(detectLanguage('src/app.tsx')).toBe('typescript')
    expect(detectLanguage('package.json')).toBe('json')
    expect(detectLanguage('styles/main.scss')).toBe('scss')
    expect(detectLanguage('scripts/setup.sh')).toBe('shell')
  })

  it('未知扩展名安全回退为纯文本', () => {
    expect(detectLanguage('notes.unknown')).toBe('plaintext')
    expect(detectLanguage('LICENSE')).toBe('plaintext')
  })
})
