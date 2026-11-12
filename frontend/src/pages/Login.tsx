import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../services/api';
import { useSession } from '../hooks/useSession';
import { errorMessage } from '../domain';
import { Notice } from '../components/Common';
export default function Login() {
  const [params] = useSearchParams(), navigate = useNavigate(), { refresh } = useSession();
  const [register, setRegister] = useState(params.get('cadastro') === '1'), [name, setName] = useState(''), [email, setEmail] = useState(''), [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  return <section className="auth-layout"><div><span className="eyebrow">BEM-VINDO AO MANGACLOUD</span><h1>Sua próxima<br />aventura<br /><em>espera por você.</em></h1><p>Uma conta. Suas estantes. Histórias para explorar.</p></div><form className="surface" onSubmit={async e => {
    e.preventDefault(); setBusy(true); setMessage('');
    try {
      if (register) { await api.post('/auth/register', { nome: name, email, senha: password }); setRegister(false); setMessage('Conta criada. Entre para começar.'); }
      else { const r = await api.post('/auth/login', { email, senha: password }); localStorage.setItem('token', r.data.token); await refresh(); navigate('/catalogo'); }
    } catch (err) { setMessage(errorMessage(err)); } finally { setBusy(false); }
  }}><h2>{register ? 'Crie sua conta' : 'Entre na sua biblioteca'}</h2>{register && <label>Nome<input required value={name} maxLength={100} autoComplete="name" onChange={e => setName(e.target.value)} /></label>}<label>Email<input required type="email" maxLength={150} autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} /></label><label>Senha<input required type="password" minLength={6} maxLength={72} autoComplete={register ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} /></label>{message && <Notice>{message}</Notice>}<button className="button primary" disabled={busy}>{busy ? 'Aguarde…' : register ? 'Criar conta gratuita' : 'Entrar →'}</button><button type="button" onClick={() => { setRegister(v => !v); setMessage(''); }}>{register ? 'Já tenho uma conta' : 'Quero criar uma conta'}</button><Link to="/forgot-password">Esqueci minha senha</Link></form></section>;
}
