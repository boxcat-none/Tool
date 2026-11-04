import { useState, type FormEvent } from "react";

interface Props {
  wrong: boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

/** 有密碼的 PDF：輸入開啟密碼 */
export function PasswordForm({ wrong, onSubmit, onCancel }: Props) {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value) onSubmit(value);
  };
  return (
    <form className="notice reader__password" onSubmit={submit}>
      <div className="notice__title">這個 PDF 有密碼保護</div>
      <label className="field">
        <span className="field__label">請輸入開啟密碼</span>
        <input type="password" autoFocus autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={wrong} />
      </label>
      {wrong && <p className="note note--error">密碼不正確，請再試一次。</p>}
      <div className="notice__actions">
        <button type="submit" className="primary" disabled={!value}>開啟</button>
        <button type="button" className="btn" onClick={onCancel}>取消</button>
      </div>
    </form>
  );
}
