import { useState } from 'react'
import type { FormEvent } from 'react'
import { Eye, EyeOff, Trash2 } from 'lucide-react'

import type { UserCreateInput, UserSummary } from '../../types'

type Props = {
  currentUser: UserSummary
  users: UserSummary[]
  busy: boolean
  error: string
  success: string
  onClose: () => void
  onCreateUser: (payload: UserCreateInput) => void | Promise<void>
  onDeleteUser: (userId: number) => void | Promise<void>
  onChangePassword: (currentPassword: string, newPassword: string) => void | Promise<void>
}

const EMPTY_USER_FORM: UserCreateInput = {
  username: '',
  display_name: '',
  password: '',
  role: 'editor',
}

export function UserSettingsModal({
  currentUser,
  users,
  busy,
  error,
  success,
  onClose,
  onCreateUser,
  onDeleteUser,
  onChangePassword,
}: Props) {
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' })
  const [userForm, setUserForm] = useState<UserCreateInput>(EMPTY_USER_FORM)
  const [newUserPasswordConfirm, setNewUserPasswordConfirm] = useState('')
  const [showPasswordForm, setShowPasswordForm] = useState(false)
  const [showCreatePassword, setShowCreatePassword] = useState(false)

  function handlePasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      return
    }
    void onChangePassword(passwordForm.currentPassword, passwordForm.newPassword)
  }

  function handleUserCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (userForm.password !== newUserPasswordConfirm) {
      return
    }
    void onCreateUser(userForm)
  }

  function handleDelete(user: UserSummary) {
    if (!window.confirm(`${user.display_name} (@${user.username}) 계정을 삭제하시겠습니까?`)) {
      return
    }
    void onDeleteUser(user.id)
  }

  const passwordInputType = showPasswordForm ? 'text' : 'password'
  const createPasswordInputType = showCreatePassword ? 'text' : 'password'

  return (
    <div className="auth-modal-backdrop" onClick={onClose}>
      <div className="auth-modal compact" onClick={(event) => event.stopPropagation()}>
        <div className="auth-modal-head compact">
          <div>
            <p className="eyebrow">User Settings</p>
            <h3>계정 설정</h3>
          </div>
          <button className="auth-close-button" type="button" onClick={onClose}>
            닫기
          </button>
        </div>

        <div className="auth-account-summary compact">
          <div className="auth-account-copy">
            <strong>{currentUser.display_name}</strong>
            <span>@{currentUser.username}</span>
          </div>
          <span className={`auth-role-chip ${currentUser.role}`}>{currentUser.role}</span>
        </div>

        {error ? <div className="auth-error">{error}</div> : null}
        {success ? <div className="auth-success">{success}</div> : null}

        <div className="auth-modal-grid compact">
          <section className="auth-modal-section compact align-start">
            <div className="auth-section-headline tight">
              <div className="auth-section-copy compact">
                <h4>비밀번호 변경</h4>
                <p>현재 로그인 계정만 수정합니다.</p>
              </div>
              <button
                className="auth-mini-button"
                type="button"
                onClick={() => setShowPasswordForm((current) => !current)}
              >
                {showPasswordForm ? <EyeOff size={14} /> : <Eye size={14} />}
                <span>{showPasswordForm ? '숨기기' : '보기'}</span>
              </button>
            </div>

            <form className="auth-form compact" onSubmit={handlePasswordSubmit}>
              <label className="auth-field">
                <span>현재 비밀번호</span>
                <input
                  type={passwordInputType}
                  value={passwordForm.currentPassword}
                  onChange={(event) => setPasswordForm((current) => ({ ...current, currentPassword: event.target.value }))}
                  required
                />
              </label>
              <label className="auth-field">
                <span>새 비밀번호</span>
                <input
                  type={passwordInputType}
                  value={passwordForm.newPassword}
                  onChange={(event) => setPasswordForm((current) => ({ ...current, newPassword: event.target.value }))}
                  required
                />
              </label>
              <label className="auth-field">
                <span>새 비밀번호 확인</span>
                <input
                  type={passwordInputType}
                  value={passwordForm.confirmPassword}
                  onChange={(event) => setPasswordForm((current) => ({ ...current, confirmPassword: event.target.value }))}
                  required
                />
              </label>
              <div className="auth-form-actions">
                <button
                  className="auth-submit"
                  type="submit"
                  disabled={
                    busy ||
                    !passwordForm.currentPassword ||
                    !passwordForm.newPassword ||
                    passwordForm.newPassword !== passwordForm.confirmPassword
                  }
                >
                  비밀번호 변경
                </button>
              </div>
            </form>
          </section>

          {currentUser.role === 'admin' ? (
            <section className="auth-modal-section compact align-start">
              <div className="auth-section-headline tight">
                <div className="auth-section-copy compact">
                  <h4>사용자 관리</h4>
                  <p>사용자 생성과 삭제를 관리합니다.</p>
                </div>
                <div className="auth-section-tools">
                  <small>{users.length} users</small>
                  <button
                    className="auth-mini-button"
                    type="button"
                    onClick={() => setShowCreatePassword((current) => !current)}
                  >
                    {showCreatePassword ? <EyeOff size={14} /> : <Eye size={14} />}
                    <span>{showCreatePassword ? '숨기기' : '보기'}</span>
                  </button>
                </div>
              </div>

              <form className="auth-form compact auth-user-create-form" onSubmit={handleUserCreate}>
                <div className="auth-form-grid">
                  <label className="auth-field">
                    <span>ID</span>
                    <input
                      value={userForm.username}
                      onChange={(event) => setUserForm((current) => ({ ...current, username: event.target.value }))}
                      required
                    />
                  </label>
                  <label className="auth-field">
                    <span>이름</span>
                    <input
                      value={userForm.display_name}
                      onChange={(event) => setUserForm((current) => ({ ...current, display_name: event.target.value }))}
                      required
                    />
                  </label>
                  <label className="auth-field">
                    <span>초기 비밀번호</span>
                    <input
                      type={createPasswordInputType}
                      value={userForm.password}
                      onChange={(event) => setUserForm((current) => ({ ...current, password: event.target.value }))}
                      required
                    />
                  </label>
                  <label className="auth-field">
                    <span>초기 비밀번호 확인</span>
                    <input
                      type={createPasswordInputType}
                      value={newUserPasswordConfirm}
                      onChange={(event) => setNewUserPasswordConfirm(event.target.value)}
                      required
                    />
                  </label>
                  <label className="auth-field auth-field-full">
                    <span>권한</span>
                    <select
                      value={userForm.role}
                      onChange={(event) =>
                        setUserForm((current) => ({ ...current, role: event.target.value as UserCreateInput['role'] }))
                      }
                    >
                      <option value="admin">admin</option>
                      <option value="editor">editor</option>
                      <option value="viewer">viewer</option>
                    </select>
                  </label>
                </div>
                <div className="auth-user-create-actions">
                  <button
                    className="auth-submit"
                    type="submit"
                    disabled={
                      busy ||
                      !userForm.username.trim() ||
                      !userForm.display_name.trim() ||
                      !userForm.password ||
                      userForm.password !== newUserPasswordConfirm
                    }
                  >
                    사용자 생성
                  </button>
                </div>
              </form>
            </section>
          ) : null}
        </div>

        {currentUser.role === 'admin' ? (
          <section className="auth-modal-section compact auth-user-list-section">
            <div className="auth-section-headline tight">
              <div className="auth-section-copy compact">
                <h4>사용자 목록</h4>
                <p>등록된 계정을 확인하고 삭제합니다.</p>
              </div>
              <small>{users.length} users</small>
            </div>

            <div className="auth-user-list compact wide">
              {users.map((user) => (
                <div key={user.id} className="auth-user-row compact">
                  <div className="auth-user-main">
                    <strong>{user.display_name}</strong>
                    <p>@{user.username}</p>
                  </div>
                  <div className="auth-user-actions">
                    <span className={`auth-role-chip ${user.role}`}>{user.role}</span>
                    <button
                      className="auth-delete-button"
                      type="button"
                      onClick={() => handleDelete(user)}
                      disabled={busy || user.id === currentUser.id}
                      title={user.id === currentUser.id ? '현재 로그인한 계정은 삭제할 수 없습니다.' : '사용자 삭제'}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  )
}
