/** UI strings (separate from module content, which is single-language). */
export const UI_LOCALES = ['en', 'zh-CN'] as const;
export type UiLocale = (typeof UI_LOCALES)[number];
export const DEFAULT_UI_LOCALE: UiLocale = 'en';

export interface Messages {
  langName: string;
  siteTitle: string;
  siteDescription: string;
  navModules: string;
  navDevelopers: string;
  searchPlaceholder: string;
  searchLabel: string;
  metamodulesOnly: string;
  sortLabel: string;
  sortUpdated: string;
  sortName: string;
  modulesCount: (n: number) => string;
  noResults: string;
  metamodule: string;
  immutable: string;
  immutableTitle: string;
  healthOk: string;
  healthStale: string;
  healthStaleTitle: (lastSuccess: string) => string;
  download: string;
  version: string;
  published: string;
  updated: string;
  license: string;
  authors: string;
  homepage: string;
  support: string;
  tags: string;
  compatibility: string;
  androidApi: string;
  architectures: string;
  any: string;
  source: string;
  repository: string;
  tag: string;
  commit: string;
  contentCommit: string;
  sha256: string;
  size: string;
  releasePage: string;
  attestation: string;
  verify: string;
  transparency: string;
  transparencyNote: string;
  releases: string;
  changelog: string;
  noChangelog: string;
  readme: string;
  noReadme: string;
  backToList: string;
  notFoundTitle: string;
  notFoundText: string;
  language: string;
  footer: string;
  lastSync: string;
  lastSyncTitle: string;
  toggleTheme: string;
  menu: string;
  mainNav: string;
  searchResults: string;
  never: string;
  latestVersion: string;
  moduleId: string;
  noModulesTitle: string;
  noModulesText: string;
  searchNoMatch: (q: string) => string;
  verifyTitle: string;
  listSubtitle: (n: number) => string;
  publishModule: string;
  allModules: string;
  filterPlaceholder: string;
  updatedPrefix: string;
  latest: string;
  viewAllReleases: string;
  assets: string;
  about: string;
  links: string;
  moduleSections: string;
  developerPortal: string;
  footerPublish: string;
  skipToContent: string;
  versionCode: string;
}

const en: Messages = {
  langName: 'English',
  siteTitle: 'KernelSU Modules',
  siteDescription: 'Modules for KernelSU, published from their authors’ GitHub repositories as immutable releases.',
  navModules: 'Modules',
  navDevelopers: 'Developers',
  searchPlaceholder: 'Search modules…',
  searchLabel: 'Search',
  metamodulesOnly: 'Metamodules only',
  sortLabel: 'Sort',
  sortUpdated: 'Recently updated',
  sortName: 'Name',
  modulesCount: (n) => (n === 1 ? '1 module' : `${n} modules`),
  noResults: 'No modules match your search.',
  metamodule: 'Metamodule',
  immutable: 'Immutable release',
  immutableTitle: 'Published as a GitHub immutable release: the tag and assets cannot be changed.',
  healthOk: 'Synced',
  healthStale: 'Stale',
  healthStaleTitle: (t) => `The last sync of this module reported a problem; showing the last good data (last change synced: ${t}).`,
  download: 'Download',
  version: 'Version',
  published: 'Published',
  updated: 'Updated',
  license: 'License',
  authors: 'Authors',
  homepage: 'Homepage',
  support: 'Support',
  tags: 'Tags',
  compatibility: 'Compatibility',
  androidApi: 'Android API',
  architectures: 'Architectures',
  any: 'Any',
  source: 'Source',
  repository: 'Repository',
  tag: 'Tag',
  commit: 'Tag commit',
  contentCommit: 'Content commit',
  sha256: 'SHA-256',
  size: 'Size',
  releasePage: 'Release page',
  attestation: 'Attestations',
  verify: 'Verify',
  transparency: 'Transparency',
  transparencyNote:
    'KernelSU Modules does not sign or audit modules. The SHA-256 only proves the download matches this index. Verify the release yourself with the GitHub CLI:',
  releases: 'Releases',
  changelog: 'Changelog',
  noChangelog: 'No release notes.',
  readme: 'Description',
  noReadme: 'No description provided.',
  backToList: 'All modules',
  notFoundTitle: 'Page not found',
  notFoundText: 'The page you requested does not exist. The module may have been removed from KernelSU Modules.',
  language: 'Language',
  footer: 'Module content belongs to its authors. Listing does not imply endorsement.',
  lastSync: 'Last change synced',
  lastSyncTitle: 'Time of the last successful sync that changed this module’s data. Syncs that find nothing new are not recorded.',
  toggleTheme: 'Toggle dark mode',
  menu: 'Menu',
  mainNav: 'Main',
  searchResults: 'Search results',
  never: 'never',
  latestVersion: 'Latest version',
  moduleId: 'Module ID',
  noModulesTitle: 'No modules yet',
  noModulesText: 'Check back later for new additions.',
  searchNoMatch: (q) => `No modules found matching “${q}”`,
  verifyTitle: 'Verify it yourself',
  listSubtitle: (n) => `${n === 1 ? '1 module' : `${n} modules`}, published by their authors as immutable GitHub releases.`,
  publishModule: 'Publish a module',
  allModules: 'All modules',
  filterPlaceholder: 'Find a module…',
  updatedPrefix: 'Updated',
  latest: 'Latest',
  viewAllReleases: 'View all releases',
  assets: 'Assets',
  about: 'About',
  links: 'Links',
  moduleSections: 'Module sections',
  developerPortal: 'KernelSU Developer Portal',
  footerPublish: 'Publishing a module? Use the',
  skipToContent: 'Skip to content',
  versionCode: 'Version code',
};

const zhCN: Messages = {
  langName: '简体中文',
  siteTitle: 'KernelSU 模块',
  siteDescription: 'KernelSU 模块：模块直接来自作者的 GitHub 仓库，以不可变 Release 发布。',
  navModules: '模块',
  navDevelopers: '开发者',
  searchPlaceholder: '搜索模块…',
  searchLabel: '搜索',
  metamodulesOnly: '仅显示元模块',
  sortLabel: '排序',
  sortUpdated: '最近更新',
  sortName: '名称',
  modulesCount: (n) => `${n} 个模块`,
  noResults: '没有符合条件的模块。',
  metamodule: '元模块',
  immutable: '不可变 Release',
  immutableTitle: '以 GitHub 不可变 Release 发布：tag 与资产无法被修改。',
  healthOk: '已同步',
  healthStale: '数据过期',
  healthStaleTitle: (t) => `该模块最近一次同步出现问题，当前显示最后一次成功的数据（最近同步到变更：${t}）。`,
  download: '下载',
  version: '版本',
  published: '发布时间',
  updated: '更新时间',
  license: '许可证',
  authors: '作者',
  homepage: '主页',
  support: '支持',
  tags: '标签',
  compatibility: '兼容性',
  androidApi: 'Android API',
  architectures: '架构',
  any: '不限',
  source: '来源',
  repository: '仓库',
  tag: 'Tag',
  commit: 'Tag commit',
  contentCommit: '内容 commit',
  sha256: 'SHA-256',
  size: '大小',
  releasePage: 'Release 页面',
  attestation: 'Attestation',
  verify: '校验',
  transparency: '透明度',
  transparencyNote: 'KernelSU 模块不对模块签名，也不审计模块代码。SHA-256 只证明下载内容与本索引一致。可使用 GitHub CLI 自行复核：',
  releases: '历史版本',
  changelog: '更新日志',
  noChangelog: '没有更新说明。',
  readme: '介绍',
  noReadme: '作者未提供介绍。',
  backToList: '全部模块',
  notFoundTitle: '页面不存在',
  notFoundText: '你访问的页面不存在，该模块可能已从 KernelSU 模块中移除。',
  language: '语言',
  footer: '模块内容归其作者所有，收录不代表认可。',
  lastSync: '最近同步到变更',
  lastSyncTitle: '最近一次带来数据变化的成功同步时间；没有发现新内容的同步不会被记录。',
  toggleTheme: '切换深色模式',
  menu: '菜单',
  mainNav: '主导航',
  searchResults: '搜索结果',
  never: '从未',
  latestVersion: '最新版本',
  moduleId: '模块 ID',
  noModulesTitle: '暂无模块',
  noModulesText: '稍后再来看看吧。',
  searchNoMatch: (q) => `没有找到与“${q}”匹配的模块`,
  verifyTitle: '自行复核',
  listSubtitle: (n) => `共 ${n} 个模块，由作者以不可变 GitHub Release 发布。`,
  publishModule: '发布模块',
  allModules: '全部模块',
  filterPlaceholder: '查找模块…',
  updatedPrefix: '更新于',
  latest: '最新',
  viewAllReleases: '查看全部版本',
  assets: '文件',
  about: '关于',
  links: '链接',
  moduleSections: '模块内容',
  developerPortal: 'KernelSU 开发者门户',
  footerPublish: '想发布模块？请前往',
  skipToContent: '跳到主要内容',
  versionCode: '版本代码',
};

export const MESSAGES: Record<UiLocale, Messages> = { en, 'zh-CN': zhCN };
