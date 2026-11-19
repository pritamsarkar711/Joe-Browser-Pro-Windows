import { contextBridge, ipcRenderer } from 'electron';

/**
 * The preload bridge.
 *
 * Exactly the calls the UI is allowed to make, and nothing else. `ipcRenderer` is not exposed: a
 * renderer that can invoke arbitrary channels is a renderer that can delete the profile store by
 * typo. Every channel here has a handler in `main/ipc.ts` and a method on `Bridge` in
 * `shared/types.ts`, which is the contract the three of them are checked against.
 */

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

const bridge = {
  /* ---------------------------------------------------------------- app */
  getAppInfo: () => invoke('app:info'),
  getSystemInfo: () => invoke('app:system'),
  getStoreStats: () => invoke('app:stats'),
  readLogTail: (lines?: number) => invoke('log:tail', lines),
  reportPayload: (note: string) => invoke('app:report', note),
  resetEverything: () => invoke('app:reset'),
  runWorkspaceAudit: () => invoke('audit:run'),
  repairWorkspace: () => invoke('audit:fix'),

  /* ---------------------------------------------------------------- profiles */
  listProfiles: () => invoke('profiles:list'),
  getProfile: (id: string) => invoke('profiles:get', id),
  getProfileLocation: (id: string) => invoke('profiles:location', id),
  getProfileRelation: (id: string) => invoke('profiles:relation', id),
  draftProfile: (input: unknown) => invoke('profiles:draft', input),
  createProfile: (input: unknown) => invoke('profiles:create', input),
  updateProfile: (id: string, patch: unknown) => invoke('profiles:update', id, patch),
  deleteProfile: (id: string) => invoke('profiles:delete', id),
  duplicateProfile: (id: string) => invoke('profiles:duplicate', id),
  renameProfile: (id: string, name: string) => invoke('profiles:rename', id, name),
  rerollFingerprint: (id: string) => invoke('profiles:reroll', id),
  randomIdentity: (id: string) => invoke('profiles:random', id),
  clearProfileData: (id: string, scope: string) => invoke('profiles:clear', id, scope),
  exportProfiles: () => invoke('profiles:export'),
  importProfiles: (maxProfiles?: number) => invoke('profiles:import', maxProfiles),

  /* ---------------------------------------------------------------- batch + bulk */
  batchCreate: (input: unknown) => invoke('profiles:batch', input),
  bulkOpen: (ids: string[]) => invoke('profiles:bulkOpen', ids),
  bulkStop: (ids: string[]) => invoke('profiles:bulkStop', ids),
  bulkDuplicate: (ids: string[]) => invoke('profiles:bulkDuplicate', ids),
  bulkDelete: (ids: string[]) => invoke('profiles:bulkDelete', ids),

  /* ---------------------------------------------------------------- sessions */
  launchProfile: (id: string, url?: string) => invoke('sessions:launch', id, url),
  stopProfile: (id: string) => invoke('sessions:stop', id),
  focusProfile: (id: string) => invoke('sessions:focus', id),
  listSessions: () => invoke('sessions:list'),
  applyProxyToSession: (id: string, proxyId?: string) => invoke('sessions:applyProxy', id, proxyId),
  screenshotProfile: (id: string) => invoke('sessions:screenshot', id),

  /* ---------------------------------------------------------------- kernels + browsers */
  listKernels: () => invoke('kernels:list'),
  downloadKernel: (id: string) => invoke('kernels:download', id),
  removeKernel: (id: string) => invoke('kernels:remove', id),
  learnMachineGpu: () => invoke('browsers:gpu'),

  /* ---------------------------------------------------------------- proxies */
  checkProxy: (config: unknown, password?: string) => invoke('proxy:check', config, password),
  checkDirect: () => invoke('proxy:checkDirect'),
  listProxies: () => invoke('proxy:list'),
  getSavedProxy: (id: string) => invoke('proxy:get', id),
  saveProxy: (entry: unknown) => invoke('proxy:save', entry),
  deleteProxy: (id: string) => invoke('proxy:delete', id),
  importProxyList: (text: string) => invoke('proxy:import', text),
  testProxyEntry: (id: string) => invoke('proxy:test', id),
  testAllProxies: () => invoke('proxy:testAll'),
  testProxyLines: (text: string) => invoke('proxy:testLines', text),
  createProfileFromProxy: (id: string) => invoke('proxy:createProfile', id),
  proxyLine: (line: string) => invoke('proxy:parseLine', line),
  proxyClipboard: () => invoke('proxy:clipboard'),
  checkIpRisk: (ip: string) => invoke('proxy:risk', ip),
  networkReport: (proxyId?: string) => invoke('proxy:network', proxyId),

  /* ---------------------------------------------------------------- fingerprint */
  runLeakCheck: (id: string) => invoke('leak:run', id),
  runLiveAudit: (id: string) => invoke('leak:live', id),
  openInProfile: (id: string, url: string) => invoke('leak:openSite', id, url),

  /* ---------------------------------------------------------------- extensions */
  listExtensions: (id?: string) => invoke('extensions:list', id),
  addExtensionByUrl: (url: string) => invoke('extensions:addUrl', url),
  addExtensionFolder: () => invoke('extensions:addFolder'),
  addExtensionFile: () => invoke('extensions:addFile'),
  toggleExtension: (id: string, enabled: boolean) => invoke('extensions:toggle', id, enabled),
  deleteExtension: (id: string) => invoke('extensions:delete', id),
  removeShippedExtension: (id: string) => invoke('extensions:removeShipped', id),
  restoreShippedExtension: (id: string) => invoke('extensions:restoreShipped', id),
  openExtensionFolder: () => invoke('extensions:openFolder'),

  /* ---------------------------------------------------------------- cookies */
  listCookieSessions: () => invoke('cookies:sessions'),
  exportCookies: (id: string) => invoke('cookies:export', id),
  importCookies: (id: string) => invoke('cookies:import', id),

  /* ---------------------------------------------------------------- history */
  listHistory: (id: string, limit?: number) => invoke('history:list', id, limit),
  listAllHistory: (limit?: number, hopsOnly?: boolean) => invoke('history:all', limit, hopsOnly),
  listHistoryProfiles: () => invoke('history:profiles'),
  clearHistory: (id: string) => invoke('history:clear', id),
  clearAllHistory: () => invoke('history:clearAll'),

  /* ---------------------------------------------------------------- trash */
  listTrash: () => invoke('trash:list'),
  restoreTrash: (file: string) => invoke('trash:restore', file),
  emptyTrash: () => invoke('trash:empty'),

  /* ---------------------------------------------------------------- shell */
  clearAllCaches: () => invoke('app:cleanCaches'),
  openDataDir: () => invoke('shell:openDataDir'),
  openProfileDir: (id: string) => invoke('shell:openProfileDir', id),
  openKernelsDir: () => invoke('shell:openKernelsDir'),
  openLogsDir: () => invoke('shell:openLogsDir'),
  openExternal: (url: string) => invoke('shell:openExternal', url),

  /* ---------------------------------------------------------------- accounts */
  lockState: () => invoke('account:state'),
  listAccounts: () => invoke('account:list'),
  registerAccount: (input: unknown) => invoke('account:register', input),
  signIn: (input: unknown) => invoke('account:signin', input),
  signOut: () => invoke('account:signout'),
  removeAccount: (email: string) => invoke('account:remove', email),
  renameAccount: (email: string, displayName: string) => invoke('account:rename', email, displayName),
  changePassword: (input: unknown) => invoke('account:password', input),
  unlock: (input: unknown) => invoke('account:unlock', input),
  setPin: (email: string, pin: string) => invoke('account:setpin', email, pin),
  checkPin: (email: string, pin: string) => invoke('account:checkpin', email, pin),
  totpSetup: (email: string) => invoke('account:totpSetup', email),
  enableTotp: (input: unknown) => invoke('account:enableTotp', input),
  disableTotp: (email: string) => invoke('account:disableTotp', email),

  /* ---------------------------------------------------------------- settings */
  getSettings: () => invoke('settings:get'),
  saveSettings: (patch: unknown) => invoke('settings:save', patch),
  listLanguages: () => invoke('settings:languages'),

  /* ---------------------------------------------------------------- window */
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winMaximize: () => ipcRenderer.invoke('win:maximize'),
  winClose: () => ipcRenderer.invoke('win:close'),
};

type Unsubscribe = () => void;

const events = {
  /**
   * Subscribe to a main-process event.
   *
   * The renderer is the one that decides when to stop listening, so every subscription returns
   * its own unsubscribe. A React effect that forgets this leaks one listener per mount, which is
   * how a window ends up showing six identical toasts.
   */
  on(channel: string, listener: (payload: unknown) => void): Unsubscribe {
    const wrapped = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },

};

// Bridge.on is part of the public API too; exposing it only on joeEvents made
// desktop-only effects crash even though the browser preview worked.
contextBridge.exposeInMainWorld('joe', { ...bridge, on: events.on });
contextBridge.exposeInMainWorld('joeEvents', events);
