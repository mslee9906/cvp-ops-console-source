import { useState } from 'react'
import type { FormEvent } from 'react'

type Props = {
  submitting: boolean
  error: string
  onSubmit: (username: string, password: string) => void | Promise<void>
}

export function LoginScreen({ submitting, error, onSubmit }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void onSubmit(username.trim(), password)
  }

  return (
    <div className="auth-screen">
      <div className="auth-panel">
        <div className="auth-copy">
          <p className="eyebrow">Access Control</p>
          <h1>CVP Ops Console</h1>
          <p>작업 보드와 현황 데이터를 사용하려면 로그인해야 합니다.</p>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="auth-field">
            <span>ID</span>
            <input value={username} onChange={(event) => setUsername(event.target.value)} autoFocus required />
          </label>

          <label className="auth-field">
            <span>비밀번호</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>

          {error ? <div className="auth-error">{error}</div> : null}

          <button className="auth-submit" type="submit" disabled={submitting || !username.trim() || !password}>
            {submitting ? '로그인 중...' : '로그인'}
          </button>
        </form>
      </div>
    </div>
  )
}

