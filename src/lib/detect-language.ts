/** 根据文件扩展名选择 Monaco 内置语言，未知文件安全地按纯文本显示。 */
export function detectLanguage(filePath: string): string {
  const extension = filePath.split('.').pop()?.toLowerCase()
  const languages: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json',
    md: 'markdown', markdown: 'markdown',
    html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c', h: 'c',
    cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    sql: 'sql',
    yml: 'yaml', yaml: 'yaml',
    toml: 'ini',
    xml: 'xml',
    vue: 'html',
    svelte: 'html',
  }
  return languages[extension ?? ''] ?? 'plaintext'
}
