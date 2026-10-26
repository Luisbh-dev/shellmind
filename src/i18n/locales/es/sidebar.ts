import type en from '../en/sidebar';

const es: typeof en = {
    label: 'Conexiones guardadas',
    addConnection: 'Nueva conexión',
    addMenu: 'Añadir conexiones',
    importSshConfig: 'Importar desde la configuración SSH',
    filterPlaceholder: 'Buscar conexiones…',
    filterLabel: 'Buscar conexiones por nombre, dirección, usuario, etiqueta o grupo',
    clearFilter: 'Borrar la búsqueda',
    clearFilters: 'Quitar los filtros',
    tagFilter: 'Filtrar por etiqueta',
    sortLabel: 'Orden: {mode}',
    sort: {
        manual: 'Orden manual',
        name: 'Nombre',
        recent: 'Usadas recientemente'
    },
    ungrouped: 'Sin grupo',
    otherConnections: 'Conexiones',
    favorites: 'Favoritos',
    addFavorite: 'Añadir a favoritos',
    removeFavorite: 'Quitar de favoritos',
    addFavoriteNamed: 'Añadir {name} a favoritos',
    removeFavoriteNamed: 'Quitar {name} de favoritos',
    favoriteFailed: 'No se pudieron actualizar tus favoritos',
    open: 'Abrir',
    openInBackground: 'abierta en segundo plano',
    openHint: 'Abierta en el espacio de trabajo: sus sesiones siguen activas mientras ves otra conexión',
    closeServer: 'Cerrar',
    closeServerNamed: 'Cerrar {name}',
    lastUsed: 'Abierto por última vez {when}',
    theme: {
        light: 'Cambiar al tema claro',
        dark: 'Cambiar al tema oscuro'
    },
    loading: 'Cargando conexiones',
    loadFailed: 'No se pudieron cargar tus conexiones',
    retry: 'Reintentar',
    empty: 'Todavía no hay conexiones',
    emptyHint: 'Añade un servidor, un bucket o una shell local para empezar.',
    noMatches: 'Ninguna conexión coincide',
    settings: 'Ajustes',
    edit: 'Editar',
    editServer: 'Editar {name}',
    moreActions: 'Más acciones para {name}',
    moveUp: 'Subir',
    moveDown: 'Bajar',
    manualOnly: 'orden manual',
    delete: 'Eliminar',
    hasNotes: 'Tiene notas',
    rowTags: 'etiquetas: {tags}',
    rowNotes: 'tiene notas',
    cliConsole: 'consola {preset}',
    systemShell: 'shell del sistema',
    deleteDialog: {
        title: 'Eliminar conexión',
        message: '¿Quitar {name} de tus conexiones?',
        openWork: 'Está abierta, y al eliminarla también terminan:',
        confirm: 'Eliminar'
    },
    deleted: 'Conexión eliminada',
    deleteFailed: 'No se pudo eliminar la conexión',
    jumpHostInUse: 'Es el host de salto de {names}. Cambia antes su host de salto.'
};

export default es;
