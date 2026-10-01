// 배포 설정 — 값만 바꾸면 되고 빌드는 필요 없다.
window.DP_CONFIG = {
  // 배포한 Cloudflare Worker 주소 (worker/README 참고). localhost에서는 무시되고 같은 서버의 /api를 쓴다.
  API_BASE: 'https://dinner-pick.01-06.workers.dev',
  // 카카오 JavaScript 키 (한끼픽과 같은 앱 키). 키는 공개되는 값이고, 카카오 디벨로퍼스 콘솔의
  // "플랫폼 > Web 사이트 도메인"에 등록된 도메인에서만 동작한다.
  KAKAO_JS_KEY: '9394ac1268768ad4accfdf8623a92f16'
};
