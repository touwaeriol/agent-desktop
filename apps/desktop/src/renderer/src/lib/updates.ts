import type { AppUpdateSnapshot } from '@shared/types'

export function updateStatusText(snapshot: AppUpdateSnapshot): string {
  switch (snapshot.status) {
    case 'checking':
      return '正在检查更新…'
    case 'available':
      return '发现新版本'
    case 'upToDate':
      return '已是最新版本'
    case 'downloading':
      return '正在下载更新…'
    case 'preparing':
      return '下载完成，准备安装…'
    case 'installing':
      return '正在安装，应用将自动重启…'
    case 'error':
      return '更新未完成'
    default:
      return '尚未检查更新'
  }
}

export function updateProgress(snapshot: AppUpdateSnapshot): number | null {
  if (!snapshot.total) return null
  return Math.min(100, Math.round((snapshot.downloaded / snapshot.total) * 100))
}

export function updateBusy(snapshot: AppUpdateSnapshot): boolean {
  return ['checking', 'downloading', 'preparing', 'installing'].includes(snapshot.status)
}
