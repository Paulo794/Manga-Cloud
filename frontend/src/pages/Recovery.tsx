import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../services/api';
import { Notice } from '../components/Common';
import { errorMessage } from '../domain';
export default function Recovery({ reset = false }: { reset?: boolean }) {
  const [params] = useSearchParams();
  const [value, setValue] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  return <section className="narrow"><form className="surface" onSubmit={async e => { e.preventDefault(); setBusy(true); try { const r = await api.post(reset ? '/auth/reset-password' : '/auth/forgot-password', reset ? { token: params.get('token'), novaSenha: value } : { email: value }); setMessage(r.data.message); } catch (err) { setMessage(errorMessage(err)); } finally { setBusy(false); } }}><span className="eyebrow">MANGACLOUD</span><h1>{reset ? 'Uma nova senha.' : 'Vamos recuperar seu acesso.'}</h1><label>{reset ? 'Nova senha' : 'Email'}<input required type={reset ? 'password' : 'email'} minLength={reset ? 6 : undefined} maxLength={reset ? 72 : 150} value={value} onChange={e => setValue(e.target.value)} autoComplete={reset ? 'new-password' : 'email'} /></label><button className="button primary" disabled={busy}>{busy ? 'Aguarde…' : reset ? 'Redefinir senha' : 'Enviar link'}</button>{message && <Notice>{message}</Notice>}<Link to="/login">← Voltar para entrar</Link></form></section>;
}
