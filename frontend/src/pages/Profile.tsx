import { useState } from 'react';
import api from '../services/api';
import { useSession } from '../hooks/useSession';
import { errorMessage } from '../domain';
import { Notice, PrivateImage } from '../components/Common';

/** Tela de perfil do usuário com edição de biografia e upload de avatar privado. */
export function Profile() {
  const { user, refresh } = useSession();
  const [bio, setBio] = useState(user?.bio || '');
  const [message, setMessage] = useState('');
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);

  return (
    <section>
      <span className="eyebrow">SUAS INFORMAÇÕES</span>
      <h1>Meu perfil<span className="accent">.</span></h1>
      <div className="profile-grid">
        <div className="surface">
          <div className="avatar">
            {user?.avatar_url
              ? <PrivateImage url={`${user.avatar_url}?v=${version}`} alt="Seu avatar" />
              : <span>{user?.nome.slice(0, 1).toUpperCase()}</span>}
          </div>
          <h2>{user?.nome}</h2>
          <p>{user?.email}</p>
          <p className="badge">{user?.role} · {user?.assinatura.plano}</p>
          <label className="file-button">
            Trocar avatar
            <input
              disabled={busy}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={async e => {
                const file = e.target.files?.[0];
                if (!file) return;
                const body = new FormData();
                body.append('file', file);
                setBusy(true);
                try {
                  await api.post('/profile/avatar', body);
                  await refresh();
                  setVersion(v => v + 1);
                  setMessage('Avatar atualizado.');
                } catch (err) {
                  setMessage(errorMessage(err));
                } finally {
                  setBusy(false);
                }
              }}
            />
          </label>
        </div>
        <form
          className="surface"
          onSubmit={async e => {
            e.preventDefault();
            setBusy(true);
            try {
              await api.put('/profile', { bio });
              await refresh();
              setMessage('Perfil salvo.');
            } catch (err) {
              setMessage(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2>Sobre você</h2>
          <label>
            Biografia
            <textarea
              aria-label="Biografia"
              maxLength={1000}
              rows={6}
              value={bio}
              onChange={e => setBio(e.target.value)}
              placeholder="Conte um pouco sobre suas leituras favoritas."
            />
          </label>
          <button className="button primary" disabled={busy}>Salvar biografia</button>
        </form>
      </div>
      {message && <Notice>{message}</Notice>}
    </section>
  );
}
