import { createContext, useContext } from 'react';
import type { Locale } from '../shared/release-api';

// Every product string is authored in Korean, English and Traditional Chinese.
const words: Record<string, readonly [string, string, string]> = {
  size: ['크기', 'Size', '大小'],
  excludedPrivate: [
    '앱 내부 기록이므로 공유하지 않습니다.',
    'Private app records are not shared.',
    '不共享應用程式的私人紀錄。',
  ],
  excludedSecret: [
    '키·인증정보 파일은 공유하지 않습니다.',
    'Key and credential files are not shared.',
    '不共享金鑰與認證資料檔案。',
  ],
  excludedBuild: [
    '의존성·빌드·임시 폴더는 공유하지 않습니다.',
    'Dependency, build and temporary folders are not shared.',
    '不共享相依套件、建置與暫存資料夾。',
  ],
  excludedLink: [
    '링크나 일반 파일이 아닌 항목은 읽거나 따라가지 않습니다.',
    'Links and non-regular items are not read or followed.',
    '不讀取或追蹤連結及非一般檔案項目。',
  ],
  binaryEncoding: [
    '원본 인코딩 또는 줄바꿈을 보존하기 위해 텍스트로 변환하지 않습니다.',
    'The original encoding or line endings are preserved without text conversion.',
    '保留原始編碼或換行格式，不轉換為文字。',
  ],
  privacyNotice: [
    '프로젝트 파일·경로, 변경 전후 내용, 활동, 편집 세션, 충돌, 체크포인트와 삭제 기록은 기기에 보관됩니다. 표시 이름, 권한, 직접 선언한 출처와 최근 프로젝트도 저장합니다. 전체 프로젝트를 암호화하는 기능은 없으므로 기기 계정과 백업을 보호하세요.\n\n팀 만들기 전에는 로컬 편집 연결만 사용합니다. 팀을 만들면 승인된 참가자에게 공유 파일과 복구·활동 기록을 전달합니다. 열람자도 받은 사본을 보관할 수 있습니다. TLS 연결로 전송을 보호하지만 호스트와 승인된 참가자는 내용을 읽을 수 있습니다. 근처 팀 검색은 같은 네트워크에 팀 이름과 공개 연결 정보를 알립니다.\n\nGitHub 미리보기는 지정한 저장소 내용을 읽습니다. PR 만들기를 명시적으로 실행해야 선택한 파일, 제목과 설명을 새 브랜치로 업로드합니다. 게시 실패 후 원격 브랜치가 남을 수 있습니다. 앱은 자동 프로젝트 업로드, 광고·분석 SDK, 자동 오류 전송 또는 AI 추론을 기본 실행하지 않습니다. AI 표시는 직접 선언이며 인증된 도구 증거가 아닙니다.\n\n저장된 GitHub 토큰과 재연결 초대는 OS 보안 저장소로 암호화합니다. 안전한 보관이 불가능하면 평문으로 대체하지 않습니다. 초대에는 접근 권한이 있으며 클립보드는 다른 앱에서도 읽을 수 있습니다. 기본 공유 제외 규칙은 모든 파일 내용의 비밀정보를 찾아내는 검사가 아닙니다.\n\n최근 목록에서 제거해도 폴더와 기록은 남습니다. 접근 취소는 이미 받은 사본을 삭제하지 않습니다. 삭제된 파일 정리나 체크포인트 삭제는 모든 과거 버전의 안전한 소거를 보장하지 않습니다. 앱에서 토큰을 지워도 GitHub의 토큰·브랜치·PR은 삭제하지 않습니다.\n\n진단과 활동 요약은 요청할 때만 클립보드로 복사합니다. 경로·이름·네트워크 주소를 공유하기 전에 검토하세요. 앱을 종료하면 팀 연결도 종료됩니다.',
    'Project files and paths, before/after content, activity, editing sessions, conflicts, checkpoints and deleted-file records are stored on your device. Display names, roles, declared sources and recent projects are also stored. Project storage is not fully encrypted; protect the device account and backups.\n\nEditing uses a local connection until you create a team. A team sends shared files and recovery/activity records to authorized participants. Viewers can keep downloaded copies. TLS protects transport, but the host and authorized participants can read the content. Nearby-team discovery advertises the team name and public connection details on the local network.\n\nGitHub preview reads the selected repository. Only an explicit Create PR action uploads selected files, title and description to a new branch. A remote branch can remain after a publishing failure. The app does not automatically upload projects or run advertising/analytics SDKs, automatic error reporting or AI inference. AI labels are self-declarations, not verified tool identity.\n\nSaved GitHub tokens and reconnect invitations use the operating system’s encrypted credential storage. There is no plaintext fallback when secure storage is unavailable. Invitations grant access, and other apps may read the clipboard. Default sharing exclusions do not detect every secret inside otherwise ordinary files.\n\nRemoving a recent entry leaves its folder and history intact. Revoking access does not remove copies already downloaded. Purging deleted records or deleting checkpoints does not guarantee secure erasure of all historical content. Clearing a saved token does not revoke it at GitHub or delete remote branches and pull requests.\n\nDiagnostics and activity summaries are copied to the clipboard only on request. Review paths, names and network addresses before sharing them. Closing the app ends its team connections.',
    '專案檔案與路徑、變更前後內容、活動、編輯工作階段、衝突、檢查點及已刪除檔案紀錄會儲存在您的裝置上。顯示名稱、權限、自行聲明的來源與最近專案也會儲存。專案儲存空間並未完全加密，請保護裝置帳戶與備份。\n\n建立團隊前，編輯僅使用本機連線。建立團隊後，共享檔案與復原、活動紀錄會傳送給獲授權的成員。檢視者也可保留已下載的副本。TLS 保護傳輸，但主機與獲授權成員仍可讀取內容。附近團隊探索會向區域網路公布團隊名稱與公開連線資訊。\n\nGitHub 預覽會讀取指定儲存庫。只有明確執行建立提取要求才會將所選檔案、標題與說明上傳至新分支。發佈失敗後，遠端分支可能仍然存在。應用程式不會自動上傳專案，也不會預設執行廣告或分析 SDK、自動錯誤回報或 AI 推論。AI 標籤為自行聲明，並非經驗證的工具身分。\n\n儲存的 GitHub 權杖與重新連線邀請會使用作業系統加密憑證儲存。無法安全儲存時，不會退回純文字儲存。邀請可授予存取權，其他應用程式也可能讀取剪貼簿。預設共享排除規則無法偵測一般檔案中的所有機密資料。\n\n從最近清單移除不會刪除資料夾與歷程。撤銷存取權不會刪除已下載副本。清理已刪除紀錄或刪除檢查點不保證安全抹除全部歷史內容。清除已儲存權杖不會在 GitHub 撤銷權杖，也不會刪除遠端分支或提取要求。\n\n只有明確要求時才會將診斷與活動摘要複製到剪貼簿。分享前請檢閱路徑、名稱與網路位址。關閉應用程式會結束團隊連線。',
  ],
  invitationRecipient: ['초대할 사람', 'Invitation recipient', '邀請對象'],
  newTeammate: ['새 팀원', 'New teammate', '新團隊成員'],
  accessRevoked: ['접근 취소됨', 'Access revoked', '存取權已撤銷'],
  expired: ['만료됨', 'Expired', '已過期'],
  renewInviteExplain: [
    '기존 팀원의 초대를 갱신합니다. 이전 초대는 만료되며, 새 초대로 같은 작업 사본에 다시 연결할 수 있습니다.',
    'Renew the existing member’s invitation. The previous invitation is invalidated; use the new invitation with the same workcopy.',
    '更新現有成員的邀請。舊邀請將失效，可使用新邀請連線至原有工作副本。',
  ],
  currentVersion: ['현재 팀 내용', 'Current team version', '目前團隊版本'],
  historicalRemote: ['충돌 당시 팀 내용', 'Team version at conflict', '衝突當時的團隊版本'],
  currentVersionHelp: [
    '팀 내용 유지 및 둘 다 보관은 검토한 현재 팀 내용을 기준으로 적용합니다.',
    'Keep team version and Keep both use the reviewed current team version.',
    '保留團隊版本與兩者皆保留會使用已檢閱的目前團隊版本。',
  ],
  restoreDeletedExplain: [
    '선택한 파일을 프로젝트에 복원하고 팀에 반영합니다. 같은 경로에 다른 파일이 있으면 먼저 확인해야 합니다.',
    'Restore the selected file to the project and team. If another file uses the same path, review it first.',
    '將選取的檔案還原至專案與團隊。如果相同路徑已有其他檔案，請先檢閱。',
  ],
  closeProject: ['프로젝트 닫기', 'Close project', '關閉專案'],
  temporary: [
    '임시 메모리 연습 · 디스크에 저장하지 않음',
    'Temporary practice · not saved to disk',
    '暫存記憶體練習 · 不會儲存至磁碟',
  ],
  desktopRequired: [
    'Cairn 데스크톱 앱에서 이 화면을 열어 주세요.',
    'Open this screen in the Cairn desktop app.',
    '請在 Cairn 桌面應用程式開啟此畫面。',
  ],
  errorIntegrity: [
    '받은 내용을 확인하지 못했습니다. 연결을 다시 시도하고 문제가 계속되면 진단 정보를 복사하세요.',
    'Received content could not be verified. Reconnect, and copy diagnostics if the problem continues.',
    '無法驗證收到的內容。請重新連線，若問題持續，請複製診斷資訊。',
  ],
  errorVersion: [
    '팀과 앱 버전이 다릅니다. 같은 버전의 앱으로 다시 연결하세요.',
    'The team uses a different app version. Reconnect with the same version.',
    '團隊使用的應用程式版本不同。請使用相同版本重新連線。',
  ],
  errorMissing: [
    '항목을 찾을 수 없습니다. 목록을 새로 고침하고 다시 선택하세요.',
    'This item could not be found. Refresh the list and select it again.',
    '找不到此項目。請重新整理清單後再次選取。',
  ],
  errorAuth: [
    '인증을 확인하지 못했습니다. 팀 소유자에게 새 초대를 요청하세요.',
    'Authentication failed. Ask the team owner for a new invitation.',
    '驗證失敗。請向團隊擁有者要求新的邀請。',
  ],
  ignoredReason: [
    '공유 제외 규칙에 해당합니다. 원래 폴더의 파일은 유지됩니다.',
    'Excluded by sharing rules. The original file remains on disk.',
    '依共享規則排除。原始檔案仍保留在磁碟。',
  ],
  home: ['홈', 'Home', '首頁'],
  projects: ['프로젝트', 'Projects', '專案'],
  files: ['파일', 'Files', '檔案'],
  activity: ['활동', 'Activity', '活動'],
  team: ['팀', 'Team', '團隊'],
  conflicts: ['충돌', 'Conflicts', '衝突'],
  checkpoints: ['체크포인트', 'Checkpoints', '檢查點'],
  deleted: ['삭제된 파일', 'Deleted files', '已刪除檔案'],
  settings: ['설정', 'Settings', '設定'],
  navWork: ['작업', 'Workspace', '工作區'],
  navCollaborate: ['협업', 'Collaboration', '協作'],
  navHistory: ['기록과 복구', 'History & recovery', '歷程與復原'],
  chooseProject: ['프로젝트 선택', 'Choose a project', '選擇專案'],
  startWithFolder: ['내 폴더에서 시작', 'Start with your folder', '從您的資料夾開始'],
  startWithFolderHelp: [
    '기기의 프로젝트 폴더를 열고, 파일과 변경 기록을 함께 관리하세요.',
    'Open a project on your device. Keep its files and change history together.',
    '開啟裝置上的專案，一起管理檔案與變更歷程。',
  ],
  startWithTeam: ['팀과 함께 작업', 'Work with your team', '與團隊共同作業'],
  startWithTeamHelp: [
    '받은 초대로 팀에 참가하고, 내 기기에 작업 사본을 받으세요.',
    'Use an invitation to join a team and receive a working copy on your device.',
    '使用邀請加入團隊，並在您的裝置上取得工作副本。',
  ],
  resumeEditing: ['편집 이어가기', 'Resume editing', '繼續編輯'],
  browseFiles: ['파일 둘러보기', 'Browse files', '瀏覽檔案'],
  continueHelp: [
    '파일을 열어 작업을 이어가세요. 저장 상태와 변경 기록도 여기서 확인할 수 있습니다.',
    'Pick up where you left off. Your save status and change history are close at hand.',
    '繼續上次的工作，隨時查看儲存狀態與變更歷程。',
  ],
  saveStatus: ['저장 상태', 'Save status', '儲存狀態'],
  saveDevice: ['내 기기', 'This device', '此裝置'],
  saveTeam: ['팀 전달', 'Team delivery', '團隊傳送'],
  saveFolder: ['프로젝트 폴더', 'Project folder', '專案資料夾'],
  saveConfirmation: ['팀원 확인', 'Team confirmation', '團隊確認'],
  reviewChanges: ['검토할 변경이 있습니다', 'Changes need a review', '有變更需要檢閱'],
  reviewConflicts: ['충돌 검토', 'Review conflicts', '檢閱衝突'],
  checkpointHelp: [
    '이전 상태 비교와 복원',
    'Compare or restore a saved point',
    '比較或還原儲存的狀態',
  ],
  manageTeam: ['팀과 연결 관리', 'Manage your team and connection', '管理團隊與連線'],
  projectsHelp: [
    '최근 작업한 폴더를 다시 열거나, 이동한 폴더의 위치를 찾아 연결하세요.',
    'Reopen a recent project, or locate its folder if it has moved.',
    '重新開啟最近的專案，或重新指定已移動的資料夾。',
  ],
  compareRestore: ['비교하고 복원', 'Compare & restore', '比較與還原'],
  settingsOwnerOnly: [
    '이 프로젝트 설정은 팀 소유자만 변경할 수 있습니다.',
    'Only the team owner can change these project settings.',
    '只有團隊擁有者可以變更這些專案設定。',
  ],
  settingsConnectFirst: [
    '프로젝트 설정을 변경하려면 먼저 팀에 연결하세요.',
    'Connect to the team before changing project settings.',
    '請先連線至團隊，再變更專案設定。',
  ],
  welcome: ['작업을 이어갈 공간', 'A space to keep working', '繼續工作的空間'],
  intro: [
    '폴더를 열고 변경 내용을 안전하게 보관하세요. 팀과 함께 편집할 수도 있습니다.',
    'Open a folder to keep changes recoverable. Invite a team when you are ready to collaborate.',
    '開啟資料夾並保留可復原的變更。準備好後即可邀請團隊共同編輯。',
  ],
  openProject: ['폴더 열기', 'Open folder', '開啟資料夾'],
  recent: ['최근 프로젝트', 'Recent projects', '最近的專案'],
  noProjects: [
    '아직 프로젝트가 없습니다. 폴더를 열어 시작하세요.',
    'No projects yet. Open a folder to begin.',
    '尚無專案。請開啟資料夾以開始。',
  ],
  open: ['열기', 'Open', '開啟'],
  current: ['현재 프로젝트', 'Current project', '目前專案'],
  locate: ['폴더 다시 찾기', 'Locate folder', '重新指定資料夾'],
  missing: ['폴더를 찾을 수 없습니다', 'Folder not found', '找不到資料夾'],
  remove: ['목록에서 제거', 'Remove from list', '從清單移除'],
  removeExplain: [
    '최근 목록에서만 제거합니다. 폴더, 파일과 변경 기록은 그대로 유지됩니다.',
    'This removes only the recent entry. The folder, files and history remain on disk.',
    '只會移除最近使用的項目。磁碟上的資料夾、檔案和歷程會保留。',
  ],
  removeConfirm: [
    '이 프로젝트를 최근 목록에서 제거할까요?',
    'Remove this project from the recent list?',
    '要從最近清單移除此專案嗎？',
  ],
  local: ['내 폴더', 'Local folder', '本機資料夾'],
  joined: ['팀 작업 사본', 'Team workcopy', '團隊工作副本'],
  copyPath: ['경로 복사', 'Copy path', '複製路徑'],
  reveal: ['폴더에서 보기', 'Show in folder', '在資料夾中顯示'],
  cancel: ['취소', 'Cancel', '取消'],
  close: ['닫기', 'Close', '關閉'],
  confirm: ['확인', 'Confirm', '確認'],
  save: ['저장', 'Save', '儲存'],
  retry: ['다시 시도', 'Retry', '重試'],
  refresh: ['새로 고침', 'Refresh', '重新整理'],
  copy: ['복사', 'Copy', '複製'],
  copied: ['복사했습니다', 'Copied', '已複製'],
  done: ['완료', 'Done', '完成'],
  search: ['검색', 'Search', '搜尋'],
  all: ['전체', 'All', '全部'],
  none: ['없음', 'None', '無'],
  loading: ['불러오는 중…', 'Loading…', '載入中…'],
  working: ['처리 중…', 'Working…', '處理中…'],
  noResults: ['일치하는 항목이 없습니다.', 'No matching items.', '沒有符合的項目。'],
  selectProject: ['먼저 프로젝트를 열어 주세요.', 'Open a project first.', '請先開啟專案。'],
  selectFile: [
    '파일을 선택해 편집을 시작하세요.',
    'Select a file to start editing.',
    '選取檔案以開始編輯。',
  ],
  searchFiles: ['파일 이름 검색', 'Search file names', '搜尋檔案名稱'],
  quickOpen: ['빠른 파일 열기', 'Quick Open', '快速開啟'],
  commands: ['명령 팔레트', 'Command palette', '命令選單'],
  shortcuts: ['단축키', 'Keyboard shortcuts', '鍵盤快速鍵'],
  newFile: ['새 파일', 'New file', '新增檔案'],
  newFolder: ['새 폴더', 'New folder', '新增資料夾'],
  rename: ['이름 변경', 'Rename', '重新命名'],
  move: ['이동', 'Move', '移動'],
  delete: ['삭제', 'Delete', '刪除'],
  path: ['프로젝트 안의 경로', 'Path within project', '專案內的路徑'],
  name: ['이름', 'Name', '名稱'],
  content: ['내용', 'Content', '內容'],
  optional: ['선택 사항', 'Optional', '選填'],
  create: ['만들기', 'Create', '建立'],
  fileActions: ['파일 작업', 'File actions', '檔案操作'],
  deleteExplain: [
    '선택한 항목과 아래 파일이 삭제된 파일 보관함으로 이동합니다. 다른 팀원에게도 반영됩니다.',
    'The selected item and files below move to Deleted files. This change also reaches your teammates.',
    '選取的項目和下列檔案會移至已刪除檔案，並同步給團隊成員。',
  ],
  changedFiles: ['영향을 받는 파일', 'Affected files', '受影響的檔案'],
  additions: ['추가', 'Added', '新增'],
  updates: ['변경', 'Changed', '變更'],
  removals: ['삭제', 'Removed', '刪除'],
  emptyFolder: ['빈 폴더', 'Empty folder', '空資料夾'],
  binary: ['미리 보기 전용 파일', 'Preview-only file', '僅供預覽的檔案'],
  binaryExplain: [
    '이 형식은 앱에서 편집하지 않습니다. 원본 바이트는 보존하며 지원되는 크기 내에서 팀에 전달합니다.',
    'This format is not edited in Cairn. Original bytes are preserved and shared within supported size limits.',
    'Cairn 不編輯此格式。原始位元組會保留，並在支援的大小限制內共享。',
  ],
  previewLimit: [
    '내용이 커서 미리 보기를 생략했습니다. 원본은 보존됩니다.',
    'Preview omitted because the content is large. The original is preserved.',
    '內容過大，已略過預覽。原始檔案會保留。',
  ],
  unsafeImage: [
    '이 파일은 안전한 이미지 형식으로 확인되지 않아 표시하지 않습니다.',
    'This file could not be verified as a safe image format.',
    '無法確認此檔案為安全的圖片格式，因此不予顯示。',
  ],
  excluded: ['공유에서 제외된 항목', 'Excluded from sharing', '未共享的項目'],
  excludedExplain: [
    '이 항목들은 원래 폴더에 남아 있습니다.',
    'These items remain in the original folder.',
    '這些項目仍保留在原始資料夾中。',
  ],
  empty: ['아직 항목이 없습니다.', 'Nothing here yet.', '目前沒有項目。'],
  localSaved: ['내 기기에 보관됨', 'Saved on this device', '已儲存於此裝置'],
  memoryPending: ['아직 이 창에만 있는 입력', 'Input waiting to be saved', '尚待儲存的輸入'],
  memoryGuard: [
    '먼저 현재 입력을 저장하거나 실행 취소하세요. 저장 전에는 프로젝트나 파일을 바꿀 수 없습니다.',
    'Save or undo the current input first. Switching projects or files is blocked until it is safely saved.',
    '請先儲存或復原目前輸入。安全儲存前無法切換專案或檔案。',
  ],
  queued: ['팀에 전달 대기 중', 'Waiting to send to team', '等待傳送至團隊'],
  delivered: ['팀에 보관됨', 'Saved by the team', '團隊已儲存'],
  diskPending: ['폴더에 반영 대기 중', 'Waiting to update folder', '等待更新資料夾'],
  diskApplied: ['폴더에 반영됨', 'Folder updated', '資料夾已更新'],
  diskBlocked: ['폴더 반영에 확인 필요', 'Folder needs attention', '資料夾需要處理'],
  peersConfirmed: [
    '현재 연결된 팀원 확인 완료',
    'Connected teammates confirmed',
    '已連線成員均已確認',
  ],
  peersWaiting: ['팀원 확인 대기 중', 'Waiting for teammate confirmation', '等待成員確認'],
  online: ['연결됨', 'Connected', '已連線'],
  offline: ['오프라인', 'Offline', '離線'],
  connecting: ['연결 중', 'Connecting', '連線中'],
  errorState: ['확인 필요', 'Needs attention', '需要處理'],
  owner: ['소유자', 'Owner', '擁有者'],
  editor: ['편집자', 'Editor', '編輯者'],
  viewer: ['열람자', 'Viewer', '檢視者'],
  saveNow: ['지금 저장', 'Save now', '立即儲存'],
  retryFolder: ['폴더 반영 재시도', 'Retry folder update', '重試資料夾更新'],
  reconnect: ['다시 연결', 'Reconnect', '重新連線'],
  watching: ['외부 변경 감지', 'Watch external changes', '偵測外部變更'],
  on: ['켜짐', 'On', '開啟'],
  off: ['꺼짐', 'Off', '關閉'],
  byFile: ['파일별', 'By file', '依檔案'],
  bySession: ['세션별', 'By session', '依工作階段'],
  actor: ['작성자', 'Author', '作者'],
  source: ['변경 출처', 'Change source', '變更來源'],
  app: ['앱에서 편집', 'Edited in app', '在應用程式編輯'],
  unknown: ['알 수 없음', 'Unknown', '未知'],
  external: [
    '외부 변경 · 도구 알 수 없음',
    'External change · tool unknown',
    '外部變更 · 工具未知',
  ],
  declaredAi: ['AI 사용 직접 선언', 'AI use self-declared', '自行聲明使用 AI'],
  recovery: ['복구 작업', 'Recovery', '復原操作'],
  system: ['시스템', 'System', '系統'],
  sourceExplain: [
    '이름이나 파일 내용으로 AI 사용을 추측하지 않습니다. AI 표시는 작성자의 직접 선언이며 도구 인증이 아닙니다.',
    'AI use is never guessed from names or file content. An AI label is the author’s declaration, not verified tool identity.',
    '不會根據名稱或檔案內容推測 AI 使用情況。AI 標籤是作者自行聲明，並非經驗證的工具身分。',
  ],
  searchActivity: [
    '경로, 작성자, 변경 내용 검색',
    'Search path, author or changed content',
    '搜尋路徑、作者或變更內容',
  ],
  compare: ['비교', 'Compare', '比較'],
  before: ['변경 전', 'Before', '變更前'],
  after: ['변경 후', 'After', '變更後'],
  base: ['기준', 'Base', '基準'],
  mine: ['내 내용', 'My version', '我的版本'],
  theirs: ['팀 내용', 'Team version', '團隊版本'],
  diff: ['변경 비교', 'Difference', '差異比較'],
  copySummary: ['요약 복사', 'Copy summary', '複製摘要'],
  sessionExplain: [
    '활동 세션은 관련 변경을 묶어 보여 줍니다. 외부 편집 세션이나 되돌리기 단위와는 다릅니다.',
    'Activity sessions group related changes. They are separate from external editing sessions and restore actions.',
    '活動工作階段會彙整相關變更，與外部編輯工作階段及復原操作不同。',
  ],
  createTeam: ['팀 만들기', 'Create team', '建立團隊'],
  createTeamExplain: [
    '현재 프로젝트를 같은 네트워크의 팀과 공유합니다. 이 앱을 종료하면 팀 연결도 종료됩니다.',
    'Share this project with a team on your network. Closing this app ends its team connection.',
    '與相同網路上的團隊共享此專案。關閉此應用程式時團隊連線也會結束。',
  ],
  joinTeam: ['팀 참가', 'Join team', '加入團隊'],
  invite: ['초대 코드', 'Invitation', '邀請碼'],
  copyInvite: ['초대 복사', 'Copy invitation', '複製邀請'],
  inviteRole: ['초대 권한', 'Invitation role', '邀請權限'],
  fingerprint: ['팀 인증 지문', 'Team fingerprint', '團隊驗證指紋'],
  expires: ['만료', 'Expires', '到期'],
  joinDirectory: ['새 작업 사본 폴더', 'Workcopy folder', '工作副本資料夾'],
  choose: ['폴더 선택', 'Choose folder', '選取資料夾'],
  joinExplain: [
    '빈 폴더 또는 이 팀의 기존 작업 사본을 선택하세요. 기존의 다른 파일은 덮어쓰지 않습니다.',
    'Choose an empty folder or an existing workcopy for this team. Unrelated files will not be overwritten.',
    '請選擇空資料夾或此團隊現有的工作副本。不會覆寫其他檔案。',
  ],
  advanced: ['고급 연결', 'Advanced connection', '進階連線'],
  address: ['직접 연결 주소', 'Direct address', '直接連線位址'],
  directHelp: [
    '자동 검색 없이도 초대와 직접 주소로 연결할 수 있습니다.',
    'An invitation and direct address work without discovery.',
    '無須自動探索也能使用邀請碼與直接位址連線。',
  ],
  discovery: ['근처 팀', 'Nearby teams', '附近的團隊'],
  discover: ['팀 다시 찾기', 'Find teams again', '重新尋找團隊'],
  discoveredHelp: [
    '검색은 공개 팀 정보만 표시합니다. 참가에는 유효한 초대가 필요합니다.',
    'Discovery shows public team details only. Joining requires a valid invitation.',
    '探索只會顯示公開團隊資訊，加入仍需有效邀請。',
  ],
  useAddress: ['이 주소 사용', 'Use address', '使用此位址'],
  peers: ['현재 연결된 팀원', 'Connected teammates', '目前已連線成員'],
  peersExplain: [
    '접속자 목록입니다. 실제 편집 커서는 해당 파일의 편집기에 표시됩니다.',
    'This is the connection list. Live editing cursors appear inside the relevant file.',
    '此清單顯示連線狀態。即時編輯游標會出現在對應檔案中。',
  ],
  revoke: ['접근 취소', 'Revoke access', '撤銷存取權'],
  revokeExplain: [
    '이 팀원의 현재 연결과 초대 권한을 취소합니다. 이미 내려받은 파일은 해당 기기에 남습니다.',
    'Revoke this member’s connection and invitation access. Files already downloaded remain on their device.',
    '撤銷此成員的連線及邀請存取權。已下載的檔案仍保留在對方裝置上。',
  ],
  leave: ['팀 나가기', 'Leave team', '離開團隊'],
  leaveExplain: [
    '팀 연결을 종료합니다. 내려받은 작업 사본은 보존됩니다.',
    'End the team connection. The downloaded workcopy is preserved.',
    '結束團隊連線。已下載的工作副本會保留。',
  ],
  transfer: ['프로젝트 받기', 'Receiving project', '接收專案'],
  authenticating: ['초대 확인 중', 'Checking invitation', '驗證邀請中'],
  manifest: ['파일 목록 받는 중', 'Receiving file list', '接收檔案清單中'],
  downloading: ['파일 내려받는 중', 'Downloading files', '下載檔案中'],
  'catching-up': ['최근 변경 반영 중', 'Receiving recent changes', '接收最近變更中'],
  verifying: ['파일 확인 중', 'Checking files', '檢查檔案中'],
  ready: ['사용 준비 완료', 'Ready to work', '已準備就緒'],
  cancelled: ['취소됨', 'Cancelled', '已取消'],
  idle: ['대기 중', 'Waiting', '等待中'],
  transferRetry: ['참가 다시 시도', 'Retry joining', '重試加入'],
  resolve: ['해결', 'Resolve', '解決'],
  resolveExplain: [
    '세 가지 내용을 검토한 뒤 적용하세요. 검토 이후 파일이 바뀌면 다시 확인해야 합니다.',
    'Review the versions before applying. If the file changes during review, compare again.',
    '套用前請檢閱各版本。如果檢閱期間檔案有變更，請重新比較。',
  ],
  keepMine: ['내 내용 유지', 'Keep mine', '保留我的版本'],
  keepTheirs: ['팀 내용 유지', 'Keep team version', '保留團隊版本'],
  keepBoth: ['둘 다 보관', 'Keep both', '兩者皆保留'],
  manual: ['직접 병합', 'Merge manually', '手動合併'],
  mergedText: ['병합한 내용', 'Merged text', '合併後的內容'],
  reason: ['사유', 'Reason', '原因'],
  conflictNotice: [
    '내용이 겹쳐 검토가 필요합니다. 양쪽 내용은 보존되어 있습니다.',
    'Overlapping changes need review. Both versions are preserved.',
    '重疊的變更需要檢閱。兩個版本均已保留。',
  ],
  checkpointName: ['체크포인트 이름', 'Checkpoint name', '檢查點名稱'],
  newCheckpoint: ['체크포인트 만들기', 'Create checkpoint', '建立檢查點'],
  protected: ['보호용 사본', 'Protective copy', '保護副本'],
  restore: ['복원', 'Restore', '還原'],
  restoreProject: ['프로젝트 복원', 'Restore project', '還原專案'],
  restoreSelected: ['선택 파일 복원', 'Restore selected files', '還原選取的檔案'],
  restoreExplain: [
    '아래 변경이 프로젝트와 팀에 반영됩니다. 복원 직전 상태의 보호 체크포인트를 함께 만듭니다.',
    'The changes below will apply to the project and team. A protective checkpoint of the current state is created as part of the restore.',
    '下列變更將套用至專案與團隊。還原時也會建立目前狀態的保護檢查點。',
  ],
  deleteCheckpoint: ['체크포인트 삭제', 'Delete checkpoint', '刪除檢查點'],
  deleteCheckpointExplain: [
    '이 체크포인트로 복원할 수 없게 됩니다. 현재 파일과 다른 체크포인트는 보존됩니다.',
    'This checkpoint will no longer be available for restore. Current files and other checkpoints remain.',
    '將無法再從此檢查點還原。目前檔案與其他檢查點會保留。',
  ],
  chooseFiles: ['복원할 파일 선택', 'Choose files to restore', '選擇要還原的檔案'],
  purge: ['영구 삭제', 'Delete permanently', '永久刪除'],
  emptyTrash: ['보관함 비우기', 'Empty deleted files', '清空已刪除檔案'],
  purgeExplain: [
    '선택한 삭제 항목의 복구 기록을 제거합니다. 독립적인 체크포인트는 삭제하지 않습니다.',
    'Remove recovery entries for the selected deleted items. Independent checkpoints are not deleted.',
    '移除所選已刪除項目的復原紀錄。不會刪除獨立的檢查點。',
  ],
  retention: ['삭제 파일 보관 기간 (일)', 'Deleted-file retention (days)', '已刪除檔案保留天數'],
  retentionExplain: [
    '보관 기간 이후 삭제 항목은 정리 대상이 됩니다. 별도의 체크포인트는 유지됩니다.',
    'Deleted entries become eligible for cleanup after the retention period. Separate checkpoints remain.',
    '超過保留天數的刪除項目可被清理。獨立檢查點會保留。',
  ],
  claims: ['편집 세션', 'Editing sessions', '編輯工作階段'],
  startClaim: ['편집 세션 시작', 'Start editing session', '開始編輯工作階段'],
  claimExplain: [
    '외부 편집 세션은 원격 변경의 폴더 반영을 잠시 보류합니다. 운영체제의 파일 잠금은 아닙니다.',
    'External editing sessions hold remote folder updates temporarily. They do not lock files in the operating system.',
    '外部編輯工作階段會暫緩將遠端變更寫入資料夾，並不會在作業系統鎖定檔案。',
  ],
  description: ['작업 설명', 'Description', '工作說明'],
  externalClaim: ['외부 앱에서 작업', 'Working in another app', '在其他應用程式作業'],
  strictClaim: ['엄격한 편집 보호 요청', 'Request strict editing protection', '要求嚴格編輯保護'],
  renew: ['기간 연장', 'Renew', '延長'],
  completeClaim: ['세션 완료', 'Complete session', '完成工作階段'],
  cancelClaim: ['세션 취소', 'Cancel session', '取消工作階段'],
  profile: ['프로필', 'Profile', '個人資料'],
  displayName: ['표시 이름', 'Display name', '顯示名稱'],
  locale: ['언어', 'Language', '語言'],
  ignore: ['공유 제외 패턴', 'Ignore patterns', '忽略規則'],
  ignoreExplain: [
    '한 줄에 하나씩 입력하세요. 제외된 파일은 디스크에서 삭제하지 않습니다.',
    'One pattern per line. Excluded files remain on disk.',
    '每行一個規則。排除的檔案仍保留於磁碟。',
  ],
  strictClaims: [
    '엄격한 편집 세션 보호',
    'Strict editing-session protection',
    '嚴格編輯工作階段保護',
  ],
  github: ['GitHub 내보내기', 'GitHub export', '匯出至 GitHub'],
  githubHelp: [
    '저장소와 대상 브랜치를 설정하고, 변경 파일을 미리 검토한 다음 명시적으로 PR을 만듭니다.',
    'Set the repository and base branch, review changed files, then explicitly create a pull request.',
    '設定儲存庫與目標分支，檢閱變更後再明確建立提取要求。',
  ],
  repoOwner: ['저장소 소유자', 'Repository owner', '儲存庫擁有者'],
  repo: ['저장소', 'Repository', '儲存庫'],
  baseBranch: ['대상 브랜치', 'Base branch', '目標分支'],
  token: ['접근 토큰', 'Access token', '存取權杖'],
  tokenSaved: [
    '토큰 보관됨 · 값을 다시 표시하지 않습니다',
    'Token saved · its value is never redisplayed',
    '已儲存權杖 · 不會再次顯示其值',
  ],
  tokenEmpty: ['보관된 토큰 없음', 'No saved token', '沒有已儲存的權杖'],
  clearToken: ['저장된 토큰 지우기', 'Clear saved token', '清除已儲存的權杖'],
  previewExport: ['변경 미리 보기', 'Preview changes', '預覽變更'],
  publish: [
    '선택한 변경으로 PR 만들기',
    'Create PR with selected changes',
    '以選取的變更建立提取要求',
  ],
  publishExplain: [
    '선택한 파일만 새 브랜치로 업로드하고 GitHub PR을 만듭니다.',
    'Upload only selected files to a new branch and create a GitHub pull request.',
    '僅將選取的檔案上傳至新分支並建立 GitHub 提取要求。',
  ],
  title: ['제목', 'Title', '標題'],
  body: ['설명', 'Description', '說明'],
  snapshot: ['스냅샷 내보내기', 'Export snapshot', '匯出快照'],
  snapshotHelp: [
    '현재 프로젝트 파일을 별도 압축 파일로 내보냅니다. 앱 기록과 접근 토큰은 포함하지 않습니다.',
    'Export current project files to a separate archive. App history and access tokens are excluded.',
    '將目前專案檔案匯出為獨立壓縮檔。不包含應用程式歷程與存取權杖。',
  ],
  exportDone: ['내보내기 완료', 'Export complete', '匯出完成'],
  saved: ['저장했습니다', 'Saved', '已儲存'],
  published: ['PR을 만들었습니다', 'Pull request created', '已建立提取要求'],
  legal: ['라이선스', 'Licenses', '授權'],
  privacy: ['개인정보', 'Privacy', '隱私權'],
  onboarding: ['사용 안내', 'Getting started', '使用指南'],
  onboarding1: [
    '1. 일반 폴더를 열면 변경 내용이 기기에 보관됩니다.',
    '1. Open a normal folder. Changes are saved on your device.',
    '1. 開啟一般資料夾。變更會儲存在您的裝置。',
  ],
  onboarding2: [
    '2. 팀을 만들고 초대를 공유하거나, 초대로 새 작업 사본을 받으세요.',
    '2. Create a team and share an invitation, or join with an invitation and workcopy folder.',
    '2. 建立團隊並分享邀請，或使用邀請與工作副本資料夾加入。',
  ],
  onboarding3: [
    '3. 활동·충돌·체크포인트에서 변경을 검토하고 복원할 수 있습니다.',
    '3. Review and recover changes in Activity, Conflicts and Checkpoints.',
    '3. 在活動、衝突與檢查點中檢閱及復原變更。',
  ],
  start: ['시작하기', 'Get started', '開始使用'],
  pcServer: ['PC 서버 — 준비 중', 'PC server — Coming Soon', 'PC 伺服器 — 即將推出'],
  pcServerHelp: [
    '별도의 상시 서버 기능은 아직 제공하지 않습니다. 팀 공유는 이 앱이 열려 있는 동안만 동작합니다.',
    'A separate always-on server is not available yet. Team sharing runs while this app is open.',
    '目前尚未提供獨立常駐伺服器。團隊共享會在此應用程式開啟時運作。',
  ],
  diagnostics: ['진단 정보 복사', 'Copy diagnostics', '複製診斷資訊'],
  simulation: ['연습 공간', 'Practice workspace', '練習工作區'],
  simulationBanner: [
    '연습 공간입니다. 실제 프로젝트 및 외부 게시와 분리되어 있습니다.',
    'Practice workspace. Isolated from real projects and external publishing.',
    '練習工作區，與真實專案及外部發佈隔離。',
  ],
  startSimulation: ['연습 공간 열기', 'Open practice workspace', '開啟練習工作區'],
  stopSimulation: ['연습 끝내기', 'Leave practice workspace', '離開練習工作區'],
  errorGeneric: [
    '작업을 완료하지 못했습니다. 입력은 유지되었습니다. 연결과 폴더 접근을 확인한 뒤 다시 시도하세요.',
    'Could not finish the action. Your input is preserved. Check the connection and folder access, then retry.',
    '無法完成操作。輸入已保留。請檢查連線與資料夾權限後重試。',
  ],
  errorStale: [
    '검토한 뒤 내용이 변경되었습니다. 닫고 최신 내용을 다시 비교해 주세요.',
    'Content changed after your review. Close and compare the latest versions again.',
    '檢閱後內容已有變更。請關閉並重新比較最新版本。',
  ],
  errorPermission: [
    '이 작업에 필요한 권한이 없습니다. 팀 소유자에게 편집 권한을 요청하세요.',
    'You do not have permission for this action. Ask the owner for editing access.',
    '您沒有執行此操作的權限。請向擁有者要求編輯權。',
  ],
  errorNetwork: [
    '연결할 수 없습니다. 초대와 주소를 확인하고 다시 연결하세요.',
    'Could not connect. Check the invitation and address, then reconnect.',
    '無法連線。請檢查邀請與位址後重新連線。',
  ],
  errorInvite: [
    '초대가 만료되었거나 유효하지 않습니다. 새 초대를 받아 다시 시도하세요.',
    'The invitation is expired or invalid. Request a new invitation and retry.',
    '邀請已過期或無效。請取得新邀請後重試。',
  ],
  errorPath: [
    '이 경로는 사용할 수 없습니다. 프로젝트 안의 다른 이름이나 빈 폴더를 선택하세요.',
    'This path cannot be used. Choose another name within the project or an empty folder.',
    '無法使用此路徑。請選擇專案內的其他名稱或空資料夾。',
  ],
  errorSize: [
    '지원되는 크기 한도를 넘었습니다. 내용을 줄이거나 원본을 별도로 보관하세요.',
    'The supported size limit was exceeded. Reduce the content or keep the original separately.',
    '超過支援的大小限制。請減少內容或另行保留原始檔案。',
  ],
  errorOperationSize: [
    '한 번에 처리하기에는 변경 범위가 너무 큽니다. 파일이나 폴더를 나누어 작업하세요. 이 변경은 적용되지 않았습니다.',
    'This change is too large for one operation. Work on smaller groups of files or folders. Nothing from this change was committed.',
    '此變更範圍過大，無法一次處理。請分批處理檔案或資料夾；這次變更尚未套用。',
  ],
  errorDisk: [
    '폴더에 쓸 수 없습니다. 권한과 사용 가능한 공간을 확인하고 다시 시도하세요.',
    'The folder could not be written. Check permissions and available space, then retry.',
    '無法寫入資料夾。請檢查權限與可用空間後重試。',
  ],
  errorLocked: [
    '다른 앱이나 편집 세션이 이 항목을 사용 중입니다. 해당 작업을 완료한 뒤 다시 시도하세요.',
    'Another app or editing session is using this item. Finish that work and retry.',
    '其他應用程式或編輯工作階段正在使用此項目。請完成該工作後重試。',
  ],
  errorGitHub: [
    'GitHub 요청을 완료하지 못했습니다. 저장소, 대상 브랜치와 토큰 권한을 확인하고 다시 미리 보세요.',
    'GitHub could not complete the request. Check the repository, base branch and token permissions, then preview again.',
    'GitHub 無法完成要求。請檢查儲存庫、目標分支與權杖權限後重新預覽。',
  ],
  errorUnsafe: [
    '안전하게 읽을 수 없는 항목입니다. 원본 폴더에서 파일 형식과 링크 여부를 확인하세요.',
    'This item cannot be read safely. Check its file format and whether it is a link in the original folder.',
    '無法安全讀取此項目。請在原始資料夾檢查格式及是否為連結。',
  ],
  errorInput: ['입력한 값을 확인해 주세요.', 'Please check the entered values.', '請檢查輸入值。'],
  errorSimulation: [
    '연습 공간에서는 이 외부 작업을 사용할 수 없습니다. 연습을 종료한 뒤 다시 시도하세요.',
    'This external action is unavailable in practice mode. Leave practice mode and retry.',
    '練習模式無法使用此外部操作。請先離開練習模式。',
  ],
  details: ['기술 정보', 'Technical details', '技術資訊'],
  recoveredInput: [
    '입력을 별도 복구 사본으로 보관했습니다',
    'Input kept in a recovery copy',
    '輸入已保留在復原副本',
  ],
  recoveredHelp: [
    '일반 작업 파일과 팀에는 아직 반영되지 않았습니다. 내용을 줄이거나 실행 취소한 뒤 다시 저장하세요.',
    'This has not reached the working file or team. Reduce or undo the content, then save again.',
    '尚未套用至工作檔案或團隊。請減少或復原內容後再次儲存。',
  ],
  editorLabel: ['공동 편집기', 'Collaborative editor', '共同編輯器'],
  teammate: ['팀원', 'Teammate', '團隊成員'],
  editorEol: [
    '파일 형식이 바뀌어 편집을 멈췄습니다. 입력을 보존하고 파일을 다시 여세요.',
    'Editing stopped because the file format changed. Preserve your input and reopen the file.',
    '檔案格式變更，已停止編輯。請保留輸入後重新開啟檔案。',
  ],
};
export const I18n = createContext<Locale>('en');
export function translate(locale: Locale, key: string): string {
  return (
    words[key]?.[locale === 'ko' ? 0 : locale === 'en' ? 1 : 2] ??
    words.errorGeneric![locale === 'ko' ? 0 : locale === 'en' ? 1 : 2]
  );
}
export function useI18n() {
  const locale = useContext(I18n);
  return { locale, t: (key: string) => translate(locale, key) };
}
export function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
    return error.code;
  return (
    String(error instanceof Error ? error.message : error).match(/\[([A-Z_]+)\]/)?.[1] ?? 'UNKNOWN'
  );
}
export function errorText(error: unknown, locale: Locale): string {
  const code = errorCode(error);
  const key =
    code === 'OPERATION_TOO_LARGE'
      ? 'errorOperationSize'
      : code === 'MEMORY_PENDING'
        ? 'memoryGuard'
        : code === 'DESKTOP_REQUIRED'
          ? 'desktopRequired'
          : /VERSION_MISMATCH/.test(code)
            ? 'errorVersion'
            : /AUTH/.test(code)
              ? 'errorAuth'
              : /BLOB_HASH|INVALID_HASH|INVALID_BARRIER|INVALID_SNAPSHOT|INVALID_DOCUMENT|INVALID_ACK|EVENT_GAP|MISSING_EVENTS/.test(
                    code,
                  )
                ? 'errorIntegrity'
                : /FILE_NOT_FOUND|FOLDER_MISSING|NOT_INITIALIZED/.test(code)
                  ? 'errorMissing'
                  : /EXCLUDED|IGNORED/.test(code)
                    ? 'ignoredReason'
                    : /SIMULATION/.test(code)
                      ? 'errorSimulation'
                      : /STALE|REVISION|GENERATION|CHANGED|CAS|PREVIEW/.test(code)
                        ? 'errorStale'
                        : /INVITE|EXPIRED|REVOKED|IDENTITY|CERTIFICATE/.test(code)
                          ? 'errorInvite'
                          : /PERMISSION|FORBIDDEN|READ_ONLY|VIEWER|OWNER/.test(code)
                            ? 'errorPermission'
                            : /GITHUB|TOKEN|EXPORT/.test(code)
                              ? 'errorGitHub'
                              : /PATH|EXISTS|COLLISION|DESTINATION|DIRECTORY_NOT_EMPTY|WORKCOPY|PROJECT_MISMATCH/.test(
                                    code,
                                  )
                                ? 'errorPath'
                                : /LIMIT|LARGE|SIZE|QUOTA/.test(code)
                                  ? 'errorSize'
                                  : /DISK|SPACE|EACCES|EPERM|ENOSPC|PROJECTION/.test(code)
                                    ? 'errorDisk'
                                    : /CLAIM|LOCK|BUSY|OWNED/.test(code)
                                      ? 'errorLocked'
                                      : /OFFLINE|CONNECT|NETWORK|TIMEOUT|SOCKET|TRANSFER/.test(code)
                                        ? 'errorNetwork'
                                        : /SYMLINK|UNSAFE|BINARY|UTF|ENCODING/.test(code)
                                          ? 'errorUnsafe'
                                          : /INVALID|SCHEMA|INPUT/.test(code)
                                            ? 'errorInput'
                                            : 'errorGeneric';
  return translate(locale, key);
}
export function sourceKey(kind: string) {
  return kind === 'declared-ai' ? 'declaredAi' : kind;
}
export function fileReason(reason: string, locale: Locale): string {
  const key = /secret|credential|\.env|private key/i.test(reason)
    ? 'excludedSecret'
    : /private.*cairn|metadata/i.test(reason)
      ? 'excludedPrivate'
      : /dependency|build|temporary|operating.system/i.test(reason)
        ? 'excludedBuild'
        : /link|junction|redirect|regular/i.test(reason)
          ? 'excludedLink'
          : /limit|larger|size|5000|256 MiB/i.test(reason)
            ? 'errorSize'
            : /UTF|encoding|line ending|byte.order|control bytes/i.test(reason)
              ? 'binaryEncoding'
              : /ignore|excluded|pattern/i.test(reason)
                ? 'ignoredReason'
                : /binary/i.test(reason)
                  ? 'binaryExplain'
                  : null;
  return key ? translate(locale, key) : errorText(reason, locale);
}
