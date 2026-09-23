import { describe, expect, it } from 'vitest'

import { selectPeerHost } from './discovery'

describe('selectPeerHost', () => {
  it('优先选择可用于 IPv4 TCP 服务的地址', () => {
    expect(selectPeerHost(['fe80::1234', '192.168.0.10'], 'host.local')).toBe('192.168.0.10')
  })

  it('没有 IPv4 时跳过无 scope 的 IPv6 link-local 地址', () => {
    expect(selectPeerHost(['fe80::1234', '2001:db8::1'], 'host.local')).toBe('2001:db8::1')
  })

  it('没有候选地址时回退到 Bonjour 主机名', () => {
    expect(selectPeerHost(undefined, 'host.local')).toBe('host.local')
  })
})
