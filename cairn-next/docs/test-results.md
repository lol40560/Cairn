# Cairn Next 0.1.0 · 역사적 로컬 시험 기록

> 이 문서는 0.1.0의 역사적 시험 기록입니다. 현재 0.2.0-rc.2 상태와 RC1 검증 기록은 [출시 준비 상태](release-readiness.md)와 [출시 후보 검증](release-validation.md)을 참조하세요. 아래의 미구현 항목·트레이 동작·시험 개수를 현재 후보의 상태로 해석하지 않습니다.

JSON·QA 화면 파일명은 로컬에만 보관된 당시 증거를 가리킵니다. 원본 보고서·시험 프로필·설치기는 이 저장소에 포함하지 않으며, 아래 파일명은 다운로드 링크가 아닙니다.

검증일: **2026-10-26, 한국 시간**. 이 보고서는 새 앱의 **0·1단계**에 대한 결과다. 기존 Cairn 실행·전체 회귀 시험이나 새 앱의 2–5단계 완료 보고가 아니다.

## 환경과 고정 버전

| 항목        | 확인 결과                                                              |
| ----------- | ---------------------------------------------------------------------- |
| 실제 호스트 | Windows 10 Home x64, build 19045                                       |
| 개발 Node   | 24.19.0 / 내장 SQLite 3.53.3                                           |
| Electron    | 45.0.0 / 내장 Node 24.22.0 / Chromium 156.0.8078.48 / SQLite 3.53.4    |
| UI·편집     | React 19.3.1, Monaco 0.57.0, Yjs 13.6.33, y-monaco 0.1.6               |
| 전송·감시   | ws 8.22.0, Chokidar 6.0.0, selfsigned 5.5.0                            |
| 개발 도구   | TypeScript 7.0.2, Vite 8.3.5, pnpm 11.25.0                             |
| 지원 판정   | Windows x64 실행 확인. macOS는 프레임워크 대상이며 앱 빌드·실행 미실시 |

정확한 전체 의존성은 package.json과 pnpm-lock.yaml에 고정했다. Node `DatabaseSync`의 사용 가능성은 CLI와 실제 Electron 런타임에서 각각 실행 확인했다. upstream SQLite API의 실험적/RC 표시는 런타임 전체 버전과 별개이므로 내장 API의 향후 안정성을 보장하지 않는다. [공식 Node 문서](https://nodejs.org/api/sqlite.html), [Electron 플랫폼 범위](https://github.com/electron/electron#platform-support).

## 최종 검사

| 검사                           | 결과·근거                                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Node·renderer TypeScript       | 통과                                                                                                                             |
| production renderer build      | 통과. Monaco 묶음 크기 경고는 남으며 실행 실패는 아님                                                                            |
| 단위·WSS·DB·분리 프로세스 시험 | **35/35 통과**, 실패·skip·TODO 0, 약 33.39초                                                                                     |
| 실제 Electron 사용자 흐름      | 개발 빌드 **15개 체크 통과**, 약 8.62초                                                                                          |
| Windows 포장 실행 파일         | 실제 exe에서 같은 15개 체크를 별도 수행. 기계 판독 결과는 아래 evidence에 보존                                                   |
| Windows 배포 빌드              | x64 unpacked 앱과 NSIS 설치 파일 생성. 설치 마법사 실행·업데이트·제거 시험은 미실시                                              |
| production dependency audit    | 알려진 취약점 보고 0 (총 39개 의존성). 앱 전체가 무결함이라는 뜻은 아님                                                          |
| Monaco sanitizer               | npm override만으로 끝내지 않고 embedded copy를 3.4.17로 연결. build module graph에서 이전 copy 포함/패치 누락 시 실패하도록 검사 |
| 원본 보존                      | 참고 checkout은 기준 커밋 그대로이며 git 상태 깨끗함. 기존 사용자 프로젝트·`.cairn`을 실행/수정하지 않음                         |

실행 명령: `node scripts/verify.cjs --desktop`, `node scripts/runtime-check.cjs`, `pnpm audit --prod --json`, `node node_modules/electron-builder/cli.js --win nsis --x64`. 포장된 exe 검사는 `CAIRN_TEST_EXECUTABLE`을 `release/win-unpacked/Cairn Next.exe`로 지정하고 `node tests/electron.e2e.cjs`를 실행한다. 테스트가 사용하는 앱 프로필/작업 폴더는 임시 경로로 격리하며, 실제 사용자 프로필과 분리했다.

## 당시 검증한 17개 시나리오

| #                                 | 결과           | 확인한 범위 / 남은 범위                                                                                                                                                                   |
| --------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 동일 위치 동시 편집            | 통과           | 독립 Y.Doc·실제 WSS 동시 변경과 별도 프로세스의 같은 위치 오프라인 변경. 양쪽 문자열이 정확히 한 번 존재하고 hash 수렴                                                                    |
| 2. 한글·중문 조합·붙여넣기        | 자동화 통과    | 실제 Monaco에 Chromium IME composition으로 한글/중문 조합·확정. 실제 Windows 클립보드 붙여넣기 및 1 MiB 초과 보존/Undo도 통과. 물리 키보드/OS IME 수동 검수는 미실시                      |
| 3. 외부 저장과 앱 편집            | 보호 경로 통과 | 기준과 다른 파일을 보존하고 projection blocked. 교체 직전 외부 저장·새 목적지 생성·크기 변경 경합 검증. 외부 delta 자동 병합은 2단계 미구현                                               |
| 4. 끊고 양쪽 수정·재접속          | 통과           | 서버+클라이언트 2개를 별도 OS 프로세스로 실행. outbox와 양쪽 최종 text/hash 검증                                                                                                          |
| 5. ACK 직후 강제 종료             | 통과           | 클라이언트가 ACK receipt를 영속 기록한 직후 서버 프로세스 SIGKILL·재시작 **3회**. 서버 DB/state/operations/identity 유지                                                                  |
| 6. 다운로드 중 수정·rename·delete | 미구현         | 프로젝트 snapshot/catch-up/파일 구조 작업은 2단계. 단일 문서 welcome의 hash 검증만 현재 구현                                                                                              |
| 7. 같은 바이너리 동시 변경        | 미구현         | 바이너리 전송·blob 충돌은 2단계                                                                                                                                                           |
| 8. 삭제 뒤 오래된 편집            | 미구현         | 삭제/tombstone은 2단계. 현재 잘못된 generation 메시지 거부는 별도 통과                                                                                                                    |
| 9. 취소/전환 뒤 늦은 응답         | 코어 통과      | 실제 인증된 WSS welcome을 지연한 relay로 이전 시도 응답이 새 상태를 초기화하지 못함을 검증. 기존 cache에 다른 프로젝트를 열면 DB hash도 그대로 보존. 전체 다중 프로젝트 UI는 미구현       |
| 10. 용량·잠금·권한 오류           | 혼합 검증 통과 | **실제 Windows FileShare.None 잠금**과 잠금 해제 후 재시도. ENOSPC/EACCES는 파일 I/O 고장 주입, 서버 COMMIT 실패는 SQLite trigger 주입. 실제 디스크를 채우거나 사용자 ACL을 변경하지 않음 |
| 11. 검색 실패와 직접 주소         | 직접 연결 통과 | 자동 검색에 의존하지 않고 자기 PC의 실제 LAN IP로 두 앱 접속. mDNS 구현 및 mDNS 장애 상황 자체는 아직 없음                                                                                |
| 12. 인증·만료·버전 오류           | 통과           | 서버 WSS 거부, 인증 전 문서 미노출, UI의 잘못된 token 입력 유지·정상 초대로 재시도                                                                                                        |
| 13. Viewer 직접 변경              | 통과           | 원시 변경 메시지를 서버가 READ_ONLY로 거부하고 revision/내용 불변                                                                                                                         |
| 14. 접근 회수 뒤 오프라인 재전송  | 통과           | 재인증 거부 후에도 exact Yjs binary, pending outbox, 작업 파일과 재시작 복원 유지. 관리 UI는 3단계                                                                                        |
| 15. checkpoint 뒤 옛 세대         | 미구현         | checkpoint 복원은 3단계. 세대 불일치 거부 및 같은 세대 서버 revision 후퇴 차단은 현재 통과                                                                                                |
| 16. 백그라운드·중지·전체 종료     | 통과           | 창 닫기→숨긴 호스트에 원격 저장 성공, 서버 중지→peer offline, 전체 종료→실행 중 서버 종료                                                                                                 |
| 17. 실제 Windows와 다른 기기      | **미실시**     | 모두 한 Windows PC의 격리 프로세스/프로필이다. 다른 물리 PC·Mac·다른 Wi-Fi를 시험했다고 주장하지 않음                                                                                     |

추가로 실제 end-to-end TLS 연결의 TCP relay에서 데이터를 양방향으로 버리고 소켓은 유지했다. 클라이언트가 **15,000 ms**에 응답 부재를 감지해 `HEARTBEAT_TIMEOUT`으로 전환했으며, pending=1의 로컬 변경을 보존했다. 통신 복구 후 명시적 connect 호출 없이 자동 재접속해 서버 저장까지 통과했다. 서버 전원·절전·네트워크 중 정확한 원인을 관측 없이 추측하지 않는다.

## 성공 판정에 사용한 증거

- 화면 문구뿐 아니라 서버·양쪽 클라이언트의 최종 텍스트, SHA-256, 실제 작업 파일을 비교했다.
- SQLite Yjs binary state를 다시 열어 decode했고, revision·operation 수·receipt·outbox와 `PRAGMA quick_check`를 검사했다.
- 중복 operation을 반복 보낸 뒤 새로운 barrier 변경을 적용해 내용·revision이 중복되지 않음을 확인했다.
- 원본 파일과 외부 충돌 버전이 recovery 또는 원래 위치에 남는지 직접 확인했다.
- 로컬/서버 파일 반영이 blocked이면 현재 접속자 전체 확인을 완료로 표시하지 않는지 검사했다.
- 앱 재시작 시 OS 보안 저장소의 실제 암호화 세션을 복구해 같은 로컬 사본으로 다시 접속했다.

## UI 확인

Browser 플러그인이 제공되지 않아 Playwright의 Electron 제어로 **실제 앱**을 검사했다. 브라우저용 모의 backend로 대체하지 않았다. 기본 content 영역 약 1384×881과 작은 데스크톱 1034×721에서 페이지 정체성, 비어 있지 않은 화면, 오류 overlay 부재, renderer 오류 0, 상태 변화, 가로 overflow 부재를 확인했다. 실제 screenshot을 시각 검사해 조작부·편집기·저장 상태·오류 안내·텍스트 가독성을 확인했다. 모바일 앱은 대상이 아니다.

증거: 개발 빌드 결과 JSON (desktop-results.json; 로컬 자료), 포장 exe 결과 JSON (desktop-results.json; 로컬 자료), 협업 화면 (desktop-collaboration.png; 로컬 자료), 오프라인 화면 (desktop-offline.png; 로컬 자료), 작은 창 (desktop-compact.png; 로컬 자료).

폴더 선택 네이티브 대화상자는 테스트가 반환 경로를 지정했다. 그 뒤 IPC, 실제 파일·DB, 인증·전송·편집은 실제 구현을 사용했다. 네이티브 대화상자의 수동 클릭은 별도 미실시 항목이다.

실제 CRLF 파일 시험에서 `alpha\r\nbeta\r\n` 끝에 `TAIL`을 넣으면 앞줄에 들어가는 위치 계산 문제를 재현했다. 초기 빈 Monaco 모델과 나중에 받은 Yjs 문서의 EOL 불일치가 원인이었다. 형식을 영속 메타데이터로 유지하고 첫 binary 내용보다 먼저 모델에 적용하도록 수정했다. 별도 Electron 회귀 **3개 체크**와 전체 삭제→클라이언트 재시작→양쪽 Enter 후 exact text/실제 파일 hash 검증이 통과했다. CRLF 회귀 결과 (newline-results.json; 로컬 자료). 이는 기존 Cairn의 버그 보고가 아니라 새 구현 과정에서 발견하고 수정한 회귀다.

## 남은 제한

- 테스트 범위는 **서버 하나·클라이언트 둘·텍스트 파일 하나**다. 5명 동시 작업, 대형 프로젝트, 장기 사용, 편집 지연 p95 등의 성능 보장은 하지 않는다. 위 초 단위 값은 시험 전체 실행 시간이며 편집 latency benchmark가 아니다.
- 대량 단일 CDP `Input.insertText` 자동 주입은 renderer 처리 지연으로 중단했다. 실제 클립보드 Ctrl+V 경로로 재검증했으며 큰 입력의 복구·실행 취소는 통과했다. 이 결과로 대용량 자동 키 입력 처리 성능을 보장하지 않는다.
- 프로세스 강제 종료와 실제 전원 차단은 다르다. 실제 전원 장애·저장 장치 고장·백업 매체 복구 시험은 수행하지 않았다.
- macOS 설치·실행, 물리 IME, 실제 두 기기, 사설 외부 네트워크, 인터넷이 물리적으로 차단된 LAN 시험은 미실시다. 구현은 중앙 클라우드/온라인 계정/유료 API를 사용하지 않는다.
- 충돌 해결 화면, 외부 도구의 미저장 버퍼 보호, 파일 트리·구조 변경·snapshot catch-up·바이너리·Activity·checkpoint·휴지통·GitHub export·edit claim·다국어·격리 데모·업데이트 데이터 보존은 후속 단계다.
- 설치 파일은 개발용 미서명이며 생성과 내부 앱 실행을 확인했다. 실제 설치/제거/업데이트 과정의 데이터 보존은 검증하지 않았다. 기본 Electron 실행 파일 아이콘도 남아 있다.
- SQLite 기록과 복구 사본은 자동 정리하지 않는다. 용량 관리 UI, 인증서 교체, 오래된 세대의 수동 회수 절차는 후속 운영 기능이다.
