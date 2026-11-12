import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

export function createResetEmailTransport() {
  const port = Number(process.env.MAILTRAP_PORT || 2525);
  if (!process.env.MAILTRAP_HOST || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP não configurado.');
  }
  return nodemailer.createTransport({
    host: process.env.MAILTRAP_HOST,
    port,
    secure: port === 465,
    connectionTimeout: 3000,
    greetingTimeout: 3000,
    socketTimeout: 5000,
    disableFileAccess: true,
    disableUrlAccess: true,
    ...(process.env.MAILTRAP_USER ? { auth: { user: process.env.MAILTRAP_USER, pass: process.env.MAILTRAP_PASS || '' } } : {})
  });
}

export const sendResetEmail = async (to: string, resetLink: string) => {
  const transporter = createResetEmailTransport();
  try {
    await transporter.sendMail({
      from: process.env.MAIL_FROM || '"MangaCloud" <noreply@lapps.studio>',
      to,
      subject: 'Recuperação de Senha',
      text: `Você solicitou a recuperação de senha. Clique no link para redefinir: ${resetLink} \n\nEste link expira em 30 minutos.`,
      html: `<p>Você solicitou a recuperação de senha.</p><p><a href="${resetLink}">Clique aqui para redefinir sua senha</a></p><p><small>Este link expira em 30 minutos.</small></p>`
    });
    console.log('Email de recuperação enviado.');
  } catch {
    console.error('Falha ao enviar email de recuperação; verificar configuração do SMTP.');
    throw new Error('Falha no envio de email');
  } finally {
    transporter.close();
  }
};
