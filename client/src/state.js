// ── Shared mutable state ──
export const STATUS_LABELS = {
  pending: '等待中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消'
};

export const MAX_REFERENCE_IMAGES = 10;
export const DEFAULT_SIZE = '3840x2160';

export const state = {
  mode: 'text',
  selectedReferences: [],
  statusFilter: 'all',
  modeFilter: 'all',
  currentPage: 1,
  totalPages: 1,
  refreshTimer: null,
  lastTaskSignature: '',
  events: null,
  currentImages: [],
  viewerIndex: 0,
  authRequired: false,
  currentUser: null,
  isAdminUser: false,
  apiBaseUrl: '',
  assistantSuggestion: ''
};
