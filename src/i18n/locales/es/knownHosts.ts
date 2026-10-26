import type en from '../en/knownHosts';

const es: typeof en = {
    action: 'Hosts conocidos',
    title: 'Hosts conocidos',
    description: 'Claves de host SSH aceptadas en la primera conexión. Olvida una clave solo tras un cambio legítimo (p. ej. un servidor reinstalado): la siguiente conexión confiará en la clave que reciba.',
    search: 'Buscar hosts conocidos',
    searchPlaceholder: 'Host, huella o nombre del servidor',
    loading: 'Cargando hosts conocidos…',
    loadFailed: 'No se pudieron cargar los hosts conocidos.',
    retry: 'Reintentar',
    empty: 'Todavía no hay claves de host guardadas. ShellMind guarda una la primera vez que se conecta a un servidor SSH.',
    noMatches: 'Ningún host conocido coincide con «{query}».',
    count: '{shown} de {total}',
    listLabel: 'Claves de host guardadas',
    usedBy: 'La usa {servers}',
    notUsed: 'Ningún servidor guardado la usa',
    via: 'a través de',
    addressVia: '{address} a través de {route}',
    firstSeen: 'Vista por primera vez el {date}',
    forget: 'Olvidar',
    forgetLabel: 'Olvidar la clave de host de {host}',
    copyFingerprint: 'Copiar la huella de {host}',
    copied: 'Huella copiada',
    copyFailed: 'No se pudo copiar al portapapeles',
    forgotten: 'Clave de host de {host} olvidada',
    forgetFailed: 'No se pudo olvidar la clave de host',
    confirmForget: {
        title: '¿Olvidar esta clave de host?',
        message: 'La siguiente conexión a {host} confiará en la clave que presente. Hazlo solo si sabes por qué ha cambiado la clave, por ejemplo tras reinstalar el servidor.',
        confirm: 'Olvidar clave'
    },
    card: {
        title: 'Clave de host',
        description: 'La clave que presentó {address} la primera vez que ShellMind se conectó. Si cambia, se rechazan las conexiones.',
        pending: 'Aún no hay ninguna clave guardada para {address}: se guarda la primera vez que ShellMind se conecta.',
        type: 'Tipo',
        fingerprint: 'Huella',
        firstSeen: 'Vista por primera vez',
        all: 'Todos los hosts conocidos'
    }
};

export default es;
