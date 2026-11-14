import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLoad } from '../hooks/useLoad';
import api from '../services/api';
import { useSession } from '../hooks/useSession';
import { errorMessage } from '../domain';
import type { Subscription } from '../domain';
import { Notice } from '../components/Common';

/** Tela de comparação de planos Free/Pro, checkout Stripe, Billing Portal e status da assinatura. */
export function Plans({ success = false }: { success?: boolean }) {
  const { user, refresh } = useSession();
  const [params] = useSearchParams();
  const portalReturned = params.get('portal') === '1';
  const { data, error: subscriptionError, reload } = useLoad<Subscription>(user ? '/assinatura' : null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [portalSyncing, setPortalSyncing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const openPortal = async () => {
    setBusy(true);
    setMessage('');
    try {
      const r = await api.post<{ url: string }>('/stripe/portal');
      window.location.assign(r.data.url);
    } catch (error) {
      setMessage(errorMessage(error));
      setBusy(false);
    }
  };

  const renewal = async (cancel: boolean) => {
    setBusy(true);
    setMessage('');
    try {
      const result = await api.post<Subscription>(cancel ? '/stripe/cancelar' : '/stripe/reativar');
      setConfirmCancel(false);
      reload();
      await refresh();
      setMessage(
        cancel
          ? result.data.isPro
            ? 'Renovação cancelada. Seu Pro continua até o fim do período pago.'
            : 'Renovação cancelada.'
          : 'Renovação mantida. Sua assinatura continuará no próximo período.'
      );
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!data || !user) return;
    if (
      data.isPro !== user.assinatura.isPro ||
      data.status !== user.assinatura.status ||
      data.cancelAtPeriodEnd !== user.assinatura.cancelAtPeriodEnd ||
      data.inadimplente !== user.assinatura.inadimplente
    ) {
      void refresh();
    }
  }, [data, user, refresh]);

  useEffect(() => {
    if ((!success && !portalReturned) || !user) return;
    let count = 0;
    let stopped = false;
    if (portalReturned) setPortalSyncing(true);
    const timer = window.setInterval(async () => {
      count++;
      try {
        const r = await api.get<Subscription>('/assinatura');
        if (
          !stopped &&
          ((success && r.data.isPro) ||
            (portalReturned && (r.data.status !== user.assinatura.status || r.data.isPro !== user.assinatura.isPro || count >= 4)))
        ) {
          await refresh();
          reload();
          if (success && r.data.isPro) setMessage('Assinatura confirmada pelo servidor.');
          if (portalReturned) setPortalSyncing(false);
          window.clearInterval(timer);
        }
      } catch {
        if (!stopped && success) setMessage('Confirmação pendente. Tente atualizar em instantes.');
      }
      if (count >= (portalReturned && !success ? 4 : 15)) {
        if (!stopped) setPortalSyncing(false);
        window.clearInterval(timer);
      }
    }, portalReturned && !success ? 1500 : 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [success, portalReturned, user?.id]);

  const showPortalButton = !!data && (data.hasBillingAccount || data.canManageRenewal || data.status !== 'none');

  return (
    <section>
      <span className="eyebrow">CONHEÇA OS RECURSOS</span>
      <h1>Um plano para explorar.</h1>
      <Notice>
        Projeto acadêmico com Stripe em modo de teste. No Free você cria até 3 estantes pessoais e lê até as 3 primeiras posições do Demo; páginas reais do MangaDex e prévias ilustrativas do AniList permanecem gratuitas.
      </Notice>
      {success && !data?.isPro && <Notice>Confirmando pagamento… O acesso depende da confirmação do servidor via webhook.</Notice>}
      {portalSyncing && <Notice>Sincronizando alterações do Portal do Cliente com o servidor…</Notice>}
      {data?.inadimplente && (
        <Notice error>
          Pagamento pendente (assinatura inadimplente): a cobrança de renovação falhou e o plano voltou para Free. Clique em Gerenciar assinatura para atualizar a forma de pagamento no Billing Portal do Stripe.
        </Notice>
      )}
      {subscriptionError && (
        <Notice error>
          {subscriptionError} <button onClick={reload}>Atualizar assinatura</button>
        </Notice>
      )}
      <div className="plans">
        <article className="surface">
          <span className="badge">FREE</span>
          <h2>Sua biblioteca começa aqui.</h2>
          <p className="plan-price">R$ 0,00 <small>/mês</small></p>
          <p>Crie estantes privadas, personalize capas e favorite suas obras.</p>
          <ul>
            <li>Catálogo, capas e metadados reais no AniList (prévia ilustrativa) e páginas reais no MangaDex</li>
            <li>Até 3 estantes pessoais privadas e favoritos</li>
            <li>Três primeiras posições de capítulos no Demo</li>
          </ul>
          <Link className="button" to={user ? '/catalogo' : '/login?cadastro=1'}>Começar gratuitamente</Link>
        </article>
        <article className="surface pro-card">
          <span className="badge">PRO · TESTE STRIPE</span>
          <h2>Continue de onde parou.</h2>
          <p className="plan-price">R$ 9,90 <small>/mês</small></p>
          <p>Experimente assinatura recorrente em ambiente de teste.</p>
          <ul>
            <li>Estantes pessoais ilimitadas com capas no MinIO</li>
            <li>Todos os capítulos do catálogo Demo desbloqueados</li>
            <li>Progresso automático e retomada entre dispositivos</li>
          </ul>
          {user ? (
            !data?.isPro && data?.status === 'active' ? (
              <button className="button primary" disabled={busy} onClick={openPortal}>Gerenciar assinatura</button>
            ) : (
              <button
                className="button primary"
                disabled={busy || !data || data.canManageRenewal}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const r = await api.post('/stripe/checkout');
                    window.location.assign(r.data.url);
                  } catch (e) {
                    setMessage(errorMessage(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {data?.isPro ? 'Pro ativo' : busy ? 'Preparando…' : 'Abrir checkout de teste →'}
              </button>
            )
          ) : (
            <Link className="button primary" to="/login">Entre para experimentar</Link>
          )}
        </article>
      </div>
      {data && (
        <div className="surface">
          <h2>Sua assinatura</h2>
          <p>
            Plano atual: <strong>{data.plano.toUpperCase()}</strong> · Status: <strong>{data.inadimplente ? `${data.status} (inadimplente)` : data.status}</strong>
            {data.acessoAte && ` · Vigência: ${new Date(data.acessoAte).toLocaleDateString('pt-BR')}`}
          </p>
          <div className="actions">
            {showPortalButton && <button className="button primary" disabled={busy} onClick={openPortal}>Gerenciar assinatura</button>}
            {data.canManageRenewal && (
              <>
                {data.cancelAtPeriodEnd
                  ? data.status === 'active' && <button disabled={busy} onClick={() => renewal(false)}>Manter renovação</button>
                  : !confirmCancel && <button disabled={busy} onClick={() => setConfirmCancel(true)}>Cancelar renovação</button>}
              </>
            )}
            <button
              disabled={busy}
              onClick={async () => {
                reload();
                try {
                  await refresh();
                } catch (error) {
                  setMessage(errorMessage(error));
                }
              }}
            >
              Atualizar assinatura
            </button>
          </div>
          {data.canManageRenewal && data.cancelAtPeriodEnd && (
            <p className="muted">Cancelamento agendado. Não haverá renovação ao fim do período atual. Sua biblioteca e seu histórico serão preservados.</p>
          )}
          {data.canManageRenewal && !data.cancelAtPeriodEnd && confirmCancel && (
            <div role="group" aria-label="Confirmar cancelamento">
              <p>Cancelar a renovação? {data.isPro && 'Você mantém o Pro até o fim do período pago. '}Suas estantes, favoritos e histórico serão preservados.</p>
              <div className="actions">
                <button disabled={busy} onClick={() => renewal(true)}>Confirmar cancelamento</button>
                <button disabled={busy} onClick={() => setConfirmCancel(false)}>Voltar</button>
              </div>
            </div>
          )}
        </div>
      )}
      {message && <Notice>{message}</Notice>}
    </section>
  );
}
