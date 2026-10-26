import type en from '../en/editor';

const es: typeof en = {
    title: 'Editando {name}',
    contentLabel: 'Contenido de {name}',
    loading: 'Abriendo {name}…',
    save: 'Guardar (Ctrl+S)',
    saving: 'Guardando…',
    saved: 'Se guardó {name}',
    saveFailed: 'No se pudo guardar {name}',
    close: 'Cerrar el editor',
    readOnly: 'Solo lectura',
    readOnlyOn: 'Solo lectura: activada',
    readOnlyOff: 'Solo lectura: desactivada',
    unsaved: 'Cambios sin guardar',
    language: 'Sintaxis',
    plainText: 'Texto sin formato',
    position: 'Lín {line}, Col {column}',
    escapeHint: 'Esc y después Tab para salir del editor',
    download: 'Descargarlo',
    openFailed: 'No se pudo abrir {name}',
    binary: 'Parece un archivo binario, así que no se puede editar aquí.',
    notUtf8: 'Este archivo no es texto UTF-8, así que no se puede editar aquí sin dañarlo.',
    tooLarge: 'El editor abre archivos de hasta {size}; este es más grande.',
    retry: 'Reintentar',
    offline: {
        message: 'Se perdió la conexión con el servidor. Vuelve a conectar para guardar cambios.',
        unsaved: 'Se perdió la conexión con el servidor. Tus cambios sin guardar se conservan aquí; vuelve a conectar para guardarlos.',
        reconnecting: 'Reconectando…',
        reconnect: 'Reconectar',
        cannotSave: 'No hay conexión con el servidor. Vuelve a conectar y guarda de nuevo.'
    },
    discard: {
        title: '¿Descartar los cambios sin guardar?',
        message: 'Se perderán tus cambios en {name}.',
        confirm: 'Descartar cambios'
    },
    conflict: {
        title: 'El archivo cambió en el servidor',
        message: '{name} se modificó después de abrirlo (ahora ocupa {size}, modificado el {date}). Al guardar, tus cambios sustituirán a los suyos.',
        gone: '{name} se eliminó del servidor después de abrirlo. Al guardar se volverá a crear.',
        confirm: 'Guardar de todos modos'
    },
    cm: {
        find: 'Buscar',
        replace: 'Reemplazar',
        next: 'siguiente',
        previous: 'anterior',
        all: 'todos',
        matchCase: 'distinguir mayúsculas',
        regexp: 'expresión regular',
        byWord: 'palabra completa',
        replaceOne: 'reemplazar',
        replaceAll: 'reemplazar todos',
        close: 'cerrar',
        currentMatch: 'coincidencia actual',
        replacedMatches: '$ coincidencias reemplazadas',
        replacedMatchOnLine: 'coincidencia reemplazada en la línea $',
        onLine: 'en la línea',
        goToLine: 'Ir a la línea',
        go: 'ir',
        foldedLines: 'Líneas plegadas',
        unfoldedLines: 'Líneas desplegadas',
        to: 'a',
        foldedCode: 'código plegado',
        unfold: 'desplegar',
        foldLine: 'Plegar línea',
        unfoldLine: 'Desplegar línea',
        completions: 'Sugerencias',
        selectionDeleted: 'Selección eliminada',
        controlCharacter: 'Carácter de control'
    }
};

export default es;
