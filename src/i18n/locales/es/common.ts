import type en from '../en/common';

const es: typeof en = {
    cancel: 'Cancelar',
    confirm: 'Confirmar',
    close: 'Cerrar',
    dismiss: 'Descartar',
    select: 'Seleccionar…',
    areYouSure: '¿Seguro?',
    loading: 'Cargando…',
    loadFailed: 'No se pudo abrir esta ventana',
    retry: 'Reintentar',
    keys: {
        shift: 'Mayús',
        delete: 'Supr',
        insert: 'Insert',
        enter: 'Intro',
        escape: 'Esc',
        backspace: 'Retroceso',
        space: 'Espacio',
        tab: 'Tab'
    },
    status: {
        idle: 'Inactivo',
        connecting: 'Conectando',
        connected: 'Conectado',
        disconnected: 'Desconectado',
        error: 'Error'
    },
    errors: {
        backendUnreachable: 'No se pudo conectar con el backend de ShellMind.',
        invalidResponse: 'El servidor devolvió una respuesta no válida.'
    },
    askAi: {
        label: 'Preguntar a la IA',
        about: 'Preguntar a la IA sobre {name}',
        selectionHint: 'Selecciona antes algunas líneas para preguntar solo por ellas.',
        prompts: {
            service: '¿Qué le pasa al servicio {name} y cómo lo soluciono?',
            container: '¿Qué le pasa al contenedor {name} y cómo lo soluciono?',
            logs: '¿Qué problema muestran los logs de {name} y cómo lo soluciono?',
            journal: '¿Qué problema muestra el journal del sistema y cómo lo soluciono?',
            selection: '¿Qué problema muestran estas líneas de log y cómo lo soluciono?',
            status: '¿Le pasa algo a este servidor y qué debería hacer?',
            triage: 'Revisa este servidor en busca de problemas: servicios con fallos, errores recientes, disco, memoria y los procesos que más consumen.'
        }
    }
};

export default es;
