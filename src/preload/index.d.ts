import { WindowAPI } from '../shared/contracts'

declare global {
  interface Window {
    api: WindowAPI
  }
}

export {}
