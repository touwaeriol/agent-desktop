import { useEffect, useState } from 'react'
import type { LoginEvent, LoginPrompt, ProviderAuthType } from '@shared/types'
import { CheckIcon, CloseIcon, CopyIcon, ExternalIcon } from './Icons'

export interface LoginState {
  loginId: string
  providerName: string
  method: ProviderAuthType
  prompt?: { promptId: string; prompt: LoginPrompt }
  events: LoginEvent[]
  result?: { ok: boolean; error?: string }
  submitting?: boolean
}

function PromptInput({
  prompt,
  disabled,
  onSubmit
}: {
  prompt: LoginPrompt
  disabled?: boolean
  onSubmit: (value: string) => void
}) {
  const [value, setValue] = useState('')

  useEffect(() => {
    setValue('')
  }, [prompt])

  if (prompt.type === 'select') {
    return (
      <div className="login-select">
        {prompt.options?.map((option) => (
          <button
            key={option.id}
            className="login-option"
            disabled={disabled}
            onClick={() => onSubmit(option.id)}
          >
            <span>{option.label}</span>
            {option.description && <small>{option.description}</small>}
          </button>
        ))}
      </div>
    )
  }

  return (
    <form
      className="login-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (!value.trim() || disabled) return
        onSubmit(value.trim())
      }}
    >
      <label>{prompt.message}</label>
      <div className="login-input-row">
        <input
          autoFocus
          type={prompt.type === 'secret' ? 'password' : 'text'}
          value={value}
          disabled={disabled}
          placeholder={prompt.placeholder ?? ''}
          onChange={(event) => setValue(event.target.value)}
          spellCheck={false}
        />
        <button type="submit" className="primary" disabled={disabled || !value.trim()}>
          继续
        </button>
      </div>
    </form>
  )
}

export function LoginDialog({
  login,
  onAnswer,
  onCancel,
  onClose,
  onOpenExternal
}: {
  login: LoginState
  onAnswer: (value: string) => void
  onCancel: () => void
  onClose: () => void
  onOpenExternal: (url: string) => void
}) {
  const authUrl = login.events.find((event) => event.type === 'auth_url')
  const deviceCode = login.events.find((event) => event.type === 'device_code')

  return (
    <div className="login-backdrop">
      <div className="login-dialog">
        <header>
          <div>
            <h3>登录 {login.providerName}</h3>
            <p>{login.method === 'oauth' ? 'OAuth / 订阅账号' : 'API Key'}</p>
          </div>
          <button className="icon-btn" onClick={login.result ? onClose : onCancel} title="关闭">
            <CloseIcon size={14} />
          </button>
        </header>

        <div className="login-events">
          {login.events.map((event, index) => {
            if (event.type === 'info') {
              return (
                <div key={index} className="login-event">
                  <span>{event.message}</span>
                  {event.links?.map((link) => (
                    <button
                      key={link.url}
                      className="link-btn"
                      onClick={() => onOpenExternal(link.url)}
                    >
                      {link.label ?? link.url}
                    </button>
                  ))}
                </div>
              )
            }
            if (event.type === 'auth_url') {
              return (
                <div key={index} className="login-event">
                  <span>浏览器已打开授权页面</span>
                  <button className="link-btn" onClick={() => onOpenExternal(event.url)}>
                    <ExternalIcon size={12} /> 重新打开授权页
                  </button>
                  {event.instructions && <small>{event.instructions}</small>}
                </div>
              )
            }
            if (event.type === 'device_code') {
              return (
                <div key={index} className="login-event device">
                  <span>在设备上输入以下代码：</span>
                  <div className="device-code">
                    <code>{event.userCode}</code>
                    <button
                      className="icon-btn"
                      title="复制"
                      onClick={() => void navigator.clipboard?.writeText(event.userCode)}
                    >
                      <CopyIcon size={13} />
                    </button>
                  </div>
                  <button
                    className="link-btn"
                    onClick={() => onOpenExternal(event.verificationUri)}
                  >
                    <ExternalIcon size={12} /> {event.verificationUri}
                  </button>
                </div>
              )
            }
            return (
              <div key={index} className="login-event progress">
                <span className="spinner" /> {event.message}
              </div>
            )
          })}
          {login.events.length === 0 && !login.prompt && !login.result && (
            <div className="login-event progress">
              <span className="spinner" /> 正在启动登录流程…
            </div>
          )}
        </div>

        {login.prompt && (
          <PromptInput
            prompt={login.prompt.prompt}
            disabled={login.submitting}
            onSubmit={onAnswer}
          />
        )}

        {!login.prompt && !login.result && (authUrl || deviceCode) && (
          <p className="login-waiting">等待浏览器完成授权…</p>
        )}

        {login.result && (
          <div className={`login-result ${login.result.ok ? 'ok' : 'error'}`}>
            {login.result.ok ? (
              <>
                <CheckIcon size={15} /> 登录成功，凭据已写入 auth.json。
              </>
            ) : (
              <>登录失败：{login.result.error}</>
            )}
          </div>
        )}

        <footer>
          {login.result ? (
            <button className="primary" onClick={onClose}>
              完成
            </button>
          ) : (
            <button className="ghost" onClick={onCancel}>
              取消
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

