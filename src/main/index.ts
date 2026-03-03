import { app, BrowserWindow, Menu, Tray, globalShortcut, nativeImage, screen, session } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { join } from 'node:path'
import fs from 'node:fs'
import {
  cleanupIpcHandlers,
  hideControlWindowFromMain,
  initializeIpcHandlers,
  panicHideOverlayFromShortcut,
  showControlWindowFromMain,
  toggleOverlayFromShortcut,
  toggleSuggestionsMuteFromShortcut
} from './ipc/handlers'

let controlWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitRequested = false

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
  window.on('close', (event) => {
    if (quitRequested) return
    event.preventDefault()
    hideControlWindowFromMain()
  })
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
  const { width } = screen.getPrimaryDisplay().workAreaSize
  const overlayWidth = Math.min(860, Math.max(560, Math.round(width * 0.56)))
  const window = new BrowserWindow({
    width: overlayWidth,
    height: 280,
    minWidth: 560,
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
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  const x = Math.max(0, Math.round((width - overlayWidth) / 2))
  window.setPosition(x, 10)

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(`${process.env.ELECTRON_RENDERER_URL}?view=overlay`)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { view: 'overlay' }
    })
  }

  return window
}

function resolveTrayImage(): Electron.NativeImage {
  const candidates = [
    join(process.resourcesPath, 'build', 'icon.ico'),
    join(process.resourcesPath, 'app.asar.unpacked', 'build', 'icon.ico'),
    join(app.getAppPath(), 'build', 'icon.ico'),
    join(__dirname, '../../build/icon.ico')
  ]

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue
    const icon = nativeImage.createFromPath(candidate)
    if (!icon.isEmpty()) {
      return icon.resize({ width: 16, height: 16 })
    }
  }

  const fallback = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9sN/gAAAAASUVORK5CYII='
  )
  return fallback.resize({ width: 16, height: 16 })
}

function createTray(): void {
  if (tray) return

  tray = new Tray(resolveTrayImage())
  tray.setToolTip('LiveTranslate Assistant')
  tray.on('double-click', () => {
    showControlWindowFromMain()
  })

  const menu = Menu.buildFromTemplate([
    {
      label: 'Paneli Goster',
      click: () => showControlWindowFromMain()
    },
    {
      label: 'Paneli Gizle',
      click: () => hideControlWindowFromMain()
    },
    {
      label: 'Overlay Goster/Gizle',
      click: () => toggleOverlayFromShortcut()
    },
    {
      label: 'Cikis',
      click: () => {
        quitRequested = true
        app.quit()
      }
    }
  ])

  tray.setContextMenu(menu)
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
  createTray()

  initializeIpcHandlers({
    controlWindow,
    overlayWindow
  })

  registerShortcuts()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      controlWindow = createControlWindow()
      overlayWindow = createOverlayWindow()
      createTray()
      initializeIpcHandlers({ controlWindow, overlayWindow })
      registerShortcuts()
      showControlWindowFromMain()
    }
  })
})

app.on('window-all-closed', () => {
  if (quitRequested) {
    cleanupIpcHandlers()
    if (process.platform !== 'darwin') app.quit()
  }
})

app.on('before-quit', () => {
  quitRequested = true
})

app.on('will-quit', () => {
  quitRequested = true
  globalShortcut.unregisterAll()
  tray?.destroy()
  tray = null
  cleanupIpcHandlers()
})
