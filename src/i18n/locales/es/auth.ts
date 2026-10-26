import type en from '../en/auth';

const es: typeof en = {
    starting: 'Iniciando el backend…',
    waiting: 'Seguimos esperando al backend en {url}…',
    retryNow: 'Reintentar ahora',
    blocked: 'El backend ha rechazado esta página: {reason}.',
    blockedHint: 'Si accedes a ShellMind mediante un dominio u otra dirección, añádela a ALLOWED_ORIGINS (o ALLOWED_HOSTS) en el servidor.',
    title: 'Se necesita el token de acceso',
    description: 'Este servidor de ShellMind solo acepta peticiones con su token de acceso. El servidor lo muestra al arrancar ("Access token: …"), salvo que se haya fijado con SHELLMIND_AUTH_TOKEN.',
    tokenLabel: 'Token de acceso',
    tokenPlaceholder: 'Pega el token de acceso',
    remember: 'Recordar en este dispositivo',
    rememberHint: 'Se guarda en este navegador. No lo marques en equipos compartidos.',
    submit: 'Desbloquear',
    rejected: 'Ese token no es válido.',
    expired: 'El token de acceso ya no es válido. Introduce el actual.',
    failed: 'No se pudo comprobar el token: {message}',
    locked: 'ShellMind está bloqueado',
    keptHint: 'Todo lo que tenías abierto sigue igual detrás de esta ventana y continúa en cuanto desbloquees.'
};

export default es;
