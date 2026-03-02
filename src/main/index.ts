import { app, BrowserWindow, globalShortcut, session } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { join } from 'node:path'
import {
  cleanupIpcHandlers,
  initializeIpcHandlers,
  panicHideOverlayFromShortcut,
  toggleOverlayFromShortcut,
  toggleSuggestionsMuteFromShortcut
} from './ipc/handlers'

let controlWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null

function hardenWindow(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    const isAllowed = is.dev ? url.startsWith('http://localhost:') : url.startsWith('file://')
    if (!isAllowed) {
      event.preventDefault()
    }
  })
}

function createControlWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a1016',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: !is.dev,
      nodeIntegration: false,
      devTools: is.dev,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    }
  })

  window.on('ready-to-show', () => window.show())
  hardenWindow(window)

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(`${process.env.ELECTRON_RENDERER_URL}?view=control`)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { view: 'control' }
    })
  }

  return window
}

function createOverlayWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 620,
    height: 300,
    minWidth: 460,
    minHeight: 220,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: !is.dev,
      nodeIntegration: false,
      devTools: is.dev,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    }
  })

  hardenWindow(window)
  window.setContentProtection(true)

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(`${process.env.ELECTRON_RENDERER_URL}?view=overlay`)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { view: 'overlay' }
    })
  }

  return window
}

function registerShortcuts(): void {
  globalShortcut.unregisterAll()

  globalShortcut.register('CommandOrControl+Shift+O', () => {
    toggleOverlayFromShortcut()
  })

  globalShortcut.register('CommandOrControl+Shift+M', () => {
    toggleSuggestionsMuteFromShortcut()
  })

  globalShortcut.register('CommandOrControl+Shift+H', () => {
    panicHideOverlayFromShortcut()
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.livetranslate.assistant')

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media' || permission === 'display-capture') {
      callback(true)
      return
    }
    callback(false)
  })

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  controlWindow = createControlWindow()
  overlayWindow = createOverlayWindow()

  initializeIpcHandlers({
    controlWindow,
    overlayWindow
  })

  registerShortcuts()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      controlWindow = createControlWindow()
      overlayWindow = createOverlayWindow()
      initializeIpcHandlers({ controlWindow, overlayWindow })
      registerShortcuts()
    }
  })
})

app.on('window-all-closed', () => {
  cleanupIpcHandlers()
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})
