// French message dictionary for the shared UI.
//
// Translation of `../i18n.ts`, key for key: every English key has exactly one French
// entry with identical `{placeholders}`. Missing keys fall back to English at
// lookup time, so this table must never drop a key when English grows.
// Brand and product names ("Dezoomify", "Chrome Web Store", "GitHub Releases",
// "GPL", "PNG", "JPEG", "URL", "CLI", "FAQ") stay literal.
//
// Erasable-syntax-only TypeScript (plain object, no enums) so node can
// type-strip it directly in tests.

export const fr = {
  "view.diagnostics.signedInNote":
    "Si ce site nécessite une connexion, ces détails peuvent contenir des informations sensibles. Vérifiez-les avant de les partager.",
  "view.diagnostics.save": "Enregistrer le rapport de diagnostic",
  "view.diagnostics.copyFailed": "Copie impossible. Sélectionnez et copiez les détails ci-dessous.",
  "view.diagnostics.loadFailed":
    "Le rapport complet est inaccessible. Les détails disponibles sont affichés ci-dessous.",
  "desktop.done.title": "Image enregistrée",
  "desktop.done.partial": "Image enregistrée avec des parties manquantes",
  "desktop.done.size": "{width} × {height} pixels",
  "desktop.done.saved": "Enregistrée dans le dossier choisi.",
  "desktop.done.open": "Ouvrir l’image",
  "desktop.done.reveal": "Afficher dans le dossier",
  "desktop.done.openError":
    "Impossible d’ouvrir l’image. Vérifiez qu’une visionneuse par défaut est installée.",
  "desktop.done.folderError":
    "Impossible d’ouvrir le dossier. Vérifiez qu’un gestionnaire de fichiers est installé.",
  "desktop.done.missingError": "L’image ou le dossier n’existe plus.",
  "view.partial.title": "L’image est incomplète",
  "view.partial.summary": "{done} fragments sur {total} ont été récupérés.",
  "view.partial.gaps":
    "L’image enregistrée aura des zones manquantes. Aucun fichier n’a encore été enregistré.",
  "view.partial.refused":
    "Le site a refusé les fragments restants. L’image enregistrée aura des zones manquantes.",
  "view.partial.save": "Enregistrer l’image incomplète",
  "view.partial.cancel": "Annuler",
  "view.partial.retry": "Réessayer les fragments en échec",
  "view.partial.accessDenied": "Le site a refusé l’accès à cette image",
  "view.partial.empty": "L’image n’a pas pu être récupérée",
  "view.partial.noneSaved":
    "Aucune partie de l’image n’a pu être récupérée. Aucun fichier n’a été enregistré.",
  "view.partial.checkSource": "Ouvrez la page source et vérifiez que sa visionneuse fonctionne.",
  "view.partial.openSource": "Ouvrir la page source",
  // Modal chrome (shared view.ts openModal).
  "view.modal.ok": "Compris",
  "view.modal.closeDialog": "Fermer la boîte de dialogue",
  "view.modal.closeTitle": "Fermer",
  // Desktop-app guidance modal.
  "view.desktop.title": "Application de bureau Dezoomify",
  "view.desktop.subtitle":
    "Application native haute performance pour les œuvres muséales gigapixels et les numérisations locales",
  "view.desktop.installer": "L’{installer} non signé pour {platform} est disponible sur",
  "view.desktop.releasesLink": "GitHub Releases",
  "view.desktop.releasesNote":
    "Pas de mise à jour automatique ; consultez GitHub Releases manuellement.",
  "view.desktop.installerMsi": "installeur .msi",
  "view.desktop.installerDmg": "installeur .dmg Apple silicon",
  "view.desktop.installerDeb": "installeur .deb",
  "view.desktop.installerGeneric": "installeur",
  "view.desktop.platformGeneric": "votre plateforme",
  "view.desktop.whyTitle": "Pourquoi utiliser l’application de bureau ?",
  "view.desktop.why1Title": "Prend en charge les œuvres très grandes :",
  "view.desktop.why1Body":
    "Un onglet de navigateur ne peut contenir qu’une certaine quantité d’image. L’application de bureau assemble l’image en mémoire (jusqu’à sa limite de canevas de 8 Gio, avec la mémoire libre correspondante) et écrit le résultat sur le disque.",
  "view.desktop.why2Title": "Enregistre l’image terminée :",
  "view.desktop.why2Body":
    "Chaque tâche est enregistrée dans un fichier de sortie sur votre ordinateur.",
  "view.desktop.why3Title": "Quand le site web ne peut pas terminer :",
  "view.desktop.why3Body":
    "Le site web interrompt la tâche avec une erreur et renvoie vers l’application de bureau pour l’image en pleine taille.",
  "view.desktop.howTitle": "Comment l’utiliser",
  "view.desktop.step1":
    "Téléchargez l’{installer} non signé pour {platform} depuis notre page GitHub Releases, puis installez-le. Il n’y a pas de mise à jour automatique.",
  "view.desktop.step2":
    "Lancez Dezoomify et collez l’adresse de votre image zoomable ou de votre manifeste.",
  "view.desktop.step3":
    "Choisissez la résolution souhaitée et le dossier de destination pour enregistrer l’image complète assemblée.",
  "view.desktop.cliTitle": "Besoin d’automatiser ? Essayez Dezoomify CLI",
  "view.desktop.cliDesc":
    "Le CLI offre un enregistrement scriptable sans interface, idéal pour les chaînes automatisées et les serveurs sans écran.",
  "view.desktop.cliLink": "Obtenir le CLI sur GitHub Releases",
  // Browser-extension guidance modal.
  "view.ext.title": "Extension de navigateur Dezoomify",
  "view.ext.subtitle":
    "Détection automatique des visionneuses pour les archives numériques protégées et les pages complexes",
  "view.ext.availableOn": "Disponible sur",
  "view.ext.chromeStore": "Chrome Web Store",
  "view.ext.firefoxStore": "Firefox Browser Add-ons",
  "view.ext.whyTitle": "Pourquoi utiliser l’extension de navigateur ?",
  "view.ext.why1Title": "Pages avec connexion :",
  "view.ext.why1Body":
    "Pendant que vous regardez une image zoomable, elle retrouve automatiquement l’image derrière la visionneuse, y compris sur les pages où vous êtes connecté, comme les portails de bibliothèques, les abonnements muséaux et les archives universitaires.",
  "view.ext.why2Title": "Simple d’utilisation :",
  "view.ext.why2Body":
    "Appuyez sur le bouton Dezoomify dans la barre d’outils du navigateur et choisissez l’image à enregistrer, ou envoyez la tâche vers l’application de bureau si l’image est très grande.",
  "view.ext.why3Title": "Respectueux de la vie privée :",
  "view.ext.why3Body":
    "Elle examine uniquement la page que vous lui avez indiquée, et seulement après que vous avez appuyé sur le bouton. Elle n’observe pas votre navigation en arrière-plan.",
  "view.ext.howTitle": "Comment l’utiliser en 3 étapes",
  "view.ext.step1": "Installez l’extension depuis le Chrome Web Store ou Firefox Browser Add-ons.",
  "view.ext.step2":
    "Rendez-vous sur la page du musée ou de la bibliothèque qui montre votre œuvre, en vous connectant si besoin.",
  "view.ext.step3":
    "Cliquez sur l’icône Dezoomify dans la barre d’outils de votre navigateur pour détecter et extraire automatiquement l’image en pleine résolution !",
  // Access request (browser-session file access), shared access-request.tsx.
  "view.access.title": "Autoriser l’accès pour continuer",
  "view.access.usesOrigin": "Cette image utilise des fichiers de {origin}.",
  "view.access.needAccess":
    "Dezoomify a besoin d’accès pour lire ces fichiers et assembler votre image dans ce navigateur.",
  "view.access.requesting": "Demande d’accès en cours…",
  "view.access.allow": "Autoriser l’accès et continuer",
  // Idle input section.
  "view.idle.clearTitle": "Effacer la saisie",
  "view.idle.submit": "Dezoomify !",
  // Job step labels.
  "view.step.discovering": "Recherche de l’image zoomable…",
  "view.step.preflighting": "Vérification de la taille de l’image…",
  "view.step.downloading": "Téléchargement des fragments…",
  "view.step.saving": "Assemblage de l’image finale…",
  "view.step.contactingDetail": "Contact de l’hôte de l’image…",
  // Live job section.
  "view.job.techDetails": "Détails techniques et journaux",
  "view.job.manyImages": "{count} images",
  "view.job.paused": "En pause",
  "view.job.retryingTiles": "Nouvelle tentative pour {count} fragments…",
  "view.job.waiting": "En attente de {host}…",
  "view.job.sourceLabel": "Source",
  "view.job.pause": "Pause",
  "view.job.resume": "Reprendre",
  "view.job.stopReturn": "Arrêter et revenir au début",
  "view.job.progressValue": "{done} terminées, {active} en cours, {remaining} restantes",
  // Display-only section.
  "view.display.title": "Aperçu affiché, non enregistré",
  "view.display.waysTitle": "Moyens d’enregistrer cette œuvre",
  "view.display.extTitle": "Guide de l’extension de navigateur",
  "view.display.extDesc":
    "Pour les pages demandant une connexion ou des cookies de session. Détecte automatiquement les visionneuses sur les pages actives.",
  "view.display.deskTitle": "Guide de l’application de bureau",
  "view.display.deskDescClean":
    "Pour un enregistrement propre en pleine taille quand le navigateur peut seulement montrer l’image.",
  "view.display.startOver": "Recommencer",
  "view.resolution.notice":
    "Le téléchargement ne se fait pas à la résolution maximale à cause des limites du navigateur. Essayez l’application de bureau pour supprimer les limites du navigateur.",
  "view.resolution.sizes":
    "Enregistrement en {selected} pixels au lieu du maximum {maximum} pixels.",
  "view.resolution.download": "Télécharger l’application de bureau",
  "view.resolution.tryMaximum": "Essayer le maximum",
  "view.resolution.stop": "Arrêter",
  // Completion section.
  "view.done.ready": "Votre image est prête.",
  "view.done.readyTitle": "Prêt à enregistrer",
  "view.done.saveNow": "Enregistrer l’image maintenant",
  "view.done.another": "Dezoomifier une autre image",
  // Failure section.
  "view.fail.title": "Impossible de dézoomifier l’image",
  "view.fail.deskDescLimits":
    "Pour les images qui dépassent les limites mémoire du navigateur, dans la limite de canevas de 8 Gio (avec la mémoire libre correspondante). Traitées en natif sur votre ordinateur.",
  "view.fail.helpTitle": "Aide et extraction d’URL",
  "view.fail.helpDesc":
    "Comment trouver l’adresse de l’image sur les sites de musées et d’archives, et quoi essayer quand rien n’est trouvé.",
  "view.fail.reportBug": "Signaler un bogue sur GitHub",
  "view.fail.retry": "Réessayer",
  "view.fail.canvasAllocation":
    "Cette image est trop grande pour être assemblée dans cet onglet. L’application de bureau peut l’enregistrer en taille réelle.",
  "view.fail.canvasContext":
    "Cet onglet n’a pas pu créer la surface de l’image à cette taille. L’application de bureau peut l’enregistrer en taille réelle.",
  // Cancelled section.
  "view.cancel.title": "Enregistrement annulé",
  "view.cancel.message": "L’enregistrement de l’image a été interrompu.",
  // Job section and share chrome.
  "view.job.countsFull": "{current} fragments sur {total}",
  "view.job.pixelCounts": "{current} sur {total}",
  "view.job.pixels": "{count} px",
  "view.job.megapixels": "{count} Mpx",
  "view.job.gigapixels": "{count} Gpx",
  "view.job.preparation":
    "{percent} % des pixels préparés. Finalisation de l’enregistrement de l’image.",
  "view.job.countsActive": "{current} fragments sur {total} · {active} en cours",
  // Recent pictures, including unsuccessful attempts.
  "view.history.title": "Images récentes",
  "view.history.empty": "Aucune image récente pour le moment. Les images lancées apparaissent ici.",
  "view.history.localOnly": "Conservé uniquement sur cet appareil.",
  "view.history.clear": "Effacer l’historique",
  "view.history.image": "Image",
  "view.history.time": "Début",
  "view.history.size": "Taille (px)",
  "view.history.status": "État",
  "view.history.remove": "Supprimer",
  "view.history.removeImage": "Supprimer {image} des images récentes",
  "view.history.status.started": "Démarré",
  "view.history.status.completed": "Terminé",
  "view.history.status.partial": "Avec des lacunes",
  "view.history.status.preview": "Aperçu seul",
  "view.history.status.failed": "Échec",
  "view.history.status.cancelled": "Annulé",
  "view.history.status.deleted": "Supprimé",
  "view.history.status.checking": "Vérification…",
  "view.history.status.unavailable": "Fichier inaccessible",
  "view.history.status.opening": "Ouverture…",
  "view.history.openImage": "Ouvrir {image}",
  "view.history.openFailed": "Impossible d’ouvrir le fichier.",
  "view.input.description":
    "Dezoomify télécharge des images zoomables sous forme de fragments depuis des bibliothèques, des musées, des galeries et d’autres sites web. Collez ci-dessous l’adresse d’une image pour la télécharger.",
  "view.input.placeholder": "Collez l’adresse d’une visionneuse ou d’un manifeste",
  "view.input.aria": "Adresse de la page contenant votre image zoomable",
  "view.input.start": "Trouver l’image",
  // Rate-limit explainers (see failure.ts plainMessageFor).
  "view.fail.rateProxy":
    "Le site qui héberge cette image limite le nombre de pages que notre serveur peut lui demander, et cette limite vient d’être atteinte, donc la page n’a pas pu être ouverte. L’extension de navigateur et l’application de bureau téléchargent depuis votre propre connexion au lieu de notre serveur, elles ne sont donc pas concernées par cette limite.",
  "view.fail.rateDirect":
    "Le site qui héberge cette image reçoit actuellement trop de demandes depuis votre propre connexion. Attendre quelques minutes suffit généralement, et l’extension de navigateur ou l’application de bureau verront le même signal d’encombrement jusque-là.",
  // Fetch-failure family (see failure.ts plainMessageFor).
  "view.fail.httpNotFound": "Cette page est introuvable. Vérifiez l’adresse et réessayez.",
  "view.fail.httpRefused":
    "Le site a refusé de partager ce fichier (HTTP {http}). Il bloque peut-être les serveurs partagés ; l’extension de navigateur ou l’application de bureau peuvent peut-être encore fonctionner.",
  "view.fail.httpSiteProblem":
    "Le site a rencontré un problème pour ouvrir cette page. Réessayez bientôt.",
  "view.fail.httpNotOpened": "Cette page n’a pas pu être ouverte. Vérifiez l’adresse et réessayez.",
  "view.fail.policyBlocked":
    "Cette adresse ne peut pas être ouverte via le site. {hint} L’extension de navigateur ou l’application de bureau peuvent peut-être encore fonctionner.",
  "view.fail.hintAddress": "Vérifiez l’adresse et réessayez.",
  "view.fail.hintPrivate": "Le site ne peut pas ouvrir les adresses privées ou locales.",
  "view.fail.hintContentType":
    "Le site a répondu avec un type de fichier que le site ne vérifie pas ici.",
  "view.fail.hintRedirect": "Le site a redirigé d’une manière que le site ne peut pas suivre.",
  "view.fail.proxyBudget":
    "Cette page est trop volumineuse à vérifier ici. Essayez l’application de bureau pour les très grandes images.",
  "view.fail.proxyFetch":
    "Le proxy de métadonnées n’a pas pu récupérer cette adresse. Réessayez bientôt.",
  // Desktop app user copy (apps/desktop/src/main.tsx). Logs and technical
  // diagnostics stay literal English and never use these keys.
  "desktop.url.invalid":
    "Veuillez saisir une adresse web valide commençant par http:// ou https://",
  "desktop.settings.unusable":
    "Ces paramètres de téléchargement ne peuvent pas être utilisés. Ajustez les paramètres surlignés et réessayez.",
  "desktop.settings.invalidSubmit":
    "Ces paramètres de téléchargement sont invalides. Ajustez-les et réessayez.",
  "desktop.output.deniedPick":
    "La destination d’enregistrement n’a pas été acceptée. Choisissez un autre fichier pour continuer.",
  "desktop.output.exists":
    "Un fichier existe déjà à la destination d’enregistrement depuis {host}. Choisissez un autre fichier ou confirmez l’écrasement pour continuer.",
  "desktop.output.destDenied":
    "La destination d’enregistrement n’a pas été acceptée depuis {host}. Choisissez un autre fichier pour continuer.",
  "desktop.job.gone":
    "Cette tâche n’est plus active depuis {host}. Recommencez avec une adresse récente.",
  "desktop.msg.thisPicture": "cette image",
  "desktop.msg.dimsPixels": "{a} par {b} pixels",
  "desktop.msg.needAbout": " Elle a besoin d’environ {need} de mémoire",
  "desktop.output.canvasLimit":
    "Cette image est trop grande pour être assemblée sur cet ordinateur ({dims},{need} à 4 octets par pixel, limite {limit}). Enregistrez une version plus petite avec Largeur max (CLI : --max-width). Note : le JPEG accepte au plus {jpegMax} pixels par côté ; gardez le PNG pour les images plus grandes. Depuis {host}.",
  "desktop.output.jpegLimit":
    "Cette image ({dims}) est trop grande pour le JPEG, qui accepte au plus {jpegMax} pixels par côté. Enregistrez-la en PNG à la place. Depuis {host}.",
  "desktop.output.webpLimit":
    "Cette image ({dims}) est trop grande pour le WebP, qui accepte au plus {webpMax} pixels par côté. Enregistrez-la en PNG à la place. Depuis {host}.",
  "desktop.tile.partialDiscarded":
    "L’image partielle a été abandonnée, aucun fichier n’a été conservé. Réessayez depuis {host} avec une connexion stable.",
  "desktop.tile.partialChoice":
    "Certaines parties de cette image depuis {host} n’ont pas pu être enregistrées. Réessayez les parties manquées, ou conservez l’image partielle avec des zones vides.",
  "view.discovery.none":
    "Aucune image zoomable trouvée à cette adresse. Essayez une page avec un visualiseur, ou essayez l’extension.",
  "desktop.plan.none":
    "Cette image n’a aucune taille utilisable à enregistrer depuis {host}. Essayez une autre image ou une Largeur max plus petite.",
  "desktop.transport.stalled":
    "Enregistrement bloqué lors du contact avec {host}. Vérifiez votre connexion et réessayez.",
  "desktop.output.writeFail":
    "Impossible d’écrire cette image depuis {host}. Choisissez une autre destination et réessayez.",
  "desktop.job.cancelledMsg":
    "L’enregistrement de l’image a été interrompu. Tout fichier inachevé a été supprimé.",
  "desktop.start.failed":
    "Impossible de démarrer l’enregistrement de cette image depuis {host}. Réessayez.",
  "desktop.choice.failed": "Ce choix n’a pas été accepté. Réessayez.",
  "desktop.internal.error":
    "Un problème inattendu a interrompu cet enregistrement depuis {host}. Réessayez, et copiez les diagnostics si cela se reproduit.",
  "desktop.save.fallback": "Impossible d’enregistrer cette image depuis {host}. Réessayez.",
  "desktop.invoke.startFallback": "Impossible de démarrer la tâche.",
  "desktop.invoke.partial": "Le choix d’image partielle a été refusé.",
  "desktop.rec.missing": "Fragments manquants : {shown}{rest}.",
  "desktop.rec.more": " et {n} de plus",
  "desktop.rec.keep": "Conserver l’image partielle",
  "desktop.rec.discard": "Abandonner la partie",
  "desktop.rec.retryTiles": "Réessayer les fragments manqués",
  "desktop.rec.missingSome": "Certains fragments n’ont pas pu être enregistrés.",
  "desktop.rec.missingCount": "Impossible d’enregistrer {count} fragments.",
  "desktop.rec.missingOne": "Impossible d’enregistrer {count} fragment.",
  "desktop.rec.missingList": "{n} fragments manquants : {shown}{rest}.",
  "desktop.rec.missingOneList": "{n} fragment manquant : {shown}{rest}.",
  "desktop.done.partialTitle": "Image partielle enregistrée",
  "desktop.done.partialDesc":
    "Ce fichier est marqué comme partiel : {summary} Les zones manquantes restent vides. Cela le distingue d’un enregistrement complet.",
  "desktop.cancel.note":
    "Enregistrement annulé. Le nettoyage est terminé et tout fichier inachevé a été supprimé.",
  "desktop.copy.diagnostics": "Copier les diagnostics",
  "desktop.copy.copied": "Copie !",
  "desktop.panel.jobActions": "Actions de la tâche de bureau",
  "desktop.settings.reset": "Réinitialiser les paramètres",
  "desktop.quick.info": "Plus d’informations",
  "desktop.quick.auto": "Automatique",
  "desktop.quick.sizeEstimate": "<{size} Mo",
  "desktop.quick.folderInfo": "Choisissez où enregistrer les images téléchargées.",
  "desktop.quick.formatInfo":
    "Choisissez un format. Le mode automatique enregistre en JPEG les images opaques jusqu’à 65 535 pixels par côté ; sinon en PNG.",
  "desktop.quick.sizeInfo":
    "Les préréglages sélectionnent le plus grand niveau source respectant ces dimensions. Si aucun ne convient, le plus petit est utilisé et peut dépasser ces dimensions et les limites de l’encodeur. Les images ne sont pas redimensionnées. Les estimations supposent les dimensions indiquées ; la taille réelle et la compatibilité du format dépendent de la source. Mo estimés = largeur × hauteur × octets/pixel / 1 000 000. PNG : 1,6 octet/pixel ; WebP sans perte : 1,3 ; TIFF/ZIF : 3. JPEG est calibré avec l’encodeur natif sur deux peintures et une carte : qualité ≤25 : 0,1 ; ≤50 : 0,15 ; ≤75 : 0,2 ; ≤90 : 0,3 ; ≤95 : 0,4 ; ≤98 : 0,45 ; ≤100 : 0,5 octet/pixel. Le mode automatique estime un JPEG opaque ; la transparence utilise le PNG. ZIF/IIIF ajoutent un tiers pour la pyramide. Toutes les estimations ajoutent une marge de 10 %, puis sont arrondies au multiple de 5 Mo supérieur. Ce sont des approximations, pas des limites garanties ; le détail, la compression source, les proportions, les métadonnées et l’encodeur influencent la taille réelle. Les tailles entière/personnalisée nécessitent les dimensions source.",
  "desktop.quick.maxWidth": "Largeur max.",
  "desktop.quick.maxHeight": "Hauteur max.",
  "desktop.quick.original": "Originale",
  "desktop.quick.userDefined": "Personnalisée",
  "desktop.quick.estimatedSize": "Taille estimée ({format})",
  "desktop.quick.networkInfo":
    "Rapide utilise jusqu’à 16 requêtes simultanées sans délai. Équilibré lance jusqu’à 5 requêtes par seconde ; Doux jusqu’à 2. Un rythme réduit peut aider les serveurs chargés.",
  "desktop.quick.source": "Selon la source",
  "desktop.quick.exact": "Personnalisé",
  "desktop.quick.upTo": "Jusqu’à {size}K",
  "desktop.quick.hint.auto": "adaptatif",
  "desktop.quick.hint.png": "sans perte",
  "desktop.quick.hint.jpeg": "compressé",
  "desktop.quick.hint.tiff": "archivage",
  "desktop.quick.hint.webp": "sans perte",
  "desktop.quick.hint.zif": "zoomable",
  "desktop.quick.hint.iiifDir": "tuilé",
  "desktop.quick.format.auto":
    "JPEG pour les images opaques jusqu’à 65 535 pixels par côté ; PNG pour la transparence ou les images plus grandes. La qualité JPEG s’applique aussi au mode automatique.",
  "desktop.quick.format.png":
    "Pixels sans perte et transparence ; fichiers plus volumineux, adaptés à la retouche.",
  "desktop.quick.format.jpeg":
    "Fichiers plus petits avec perte. Sans transparence ; limite de 65 535 pixels par côté. Qualité réglable dans les paramètres.",
  "desktop.quick.format.tiff": "Sortie sans perte pour l’archivage et la retouche.",
  "desktop.quick.format.webp": "Sortie compressée sans perte, limitée à 16 383 pixels par côté.",
  "desktop.quick.format.zif":
    "Pyramide TIFF tuilée sans perte pour zoomer à plusieurs résolutions.",
  "desktop.quick.format.iiifDir":
    "Dossier de tuiles JPEG et info.json pour héberger une image IIIF.",
  "desktop.quick.rate.maximum": "16 simultanées",
  "desktop.quick.rate.balanced": "5/s",
  "desktop.quick.rate.gentle": "2/s",
  "desktop.quick.folder": "Dossier",
  "desktop.quick.askEachTime": "Demander à chaque fois",
  "desktop.quick.chosenFolder": "Dossier choisi",
  "desktop.quick.chooseFolder": "Choisir le dossier de départ de la boîte d’enregistrement",
  "desktop.quick.format": "Format",
  "desktop.quick.size": "Taille",
  "desktop.quick.network": "Réseau",
  "desktop.quick.fast": "Rapide",
  "desktop.quick.balanced": "Équilibré",
  "desktop.quick.gentle": "Doux",
  "desktop.quick.fullResolution": "Résolution complète",
  "desktop.quick.upTo4k": "Jusqu’à 4K",
  "desktop.quick.upTo2k": "Jusqu’à 2K",
  "desktop.quick.custom": "Personnalisé…",
  "desktop.quick.more": "Plus de réglages",
  "desktop.advanced.title": "Réglages avancés",
  "desktop.advanced.done": "Terminé",
  "desktop.advanced.jpegQuality": "Qualité JPEG",
  "desktop.advanced.jpegQualityDesc": "Une valeur plus élevée conserve davantage de détails.",
  "desktop.advanced.compressionEffort": "Effort de compression",
  "desktop.advanced.compressionEffortDesc":
    "La qualité reste sans perte ; une valeur plus élevée prend plus de temps.",
  "desktop.advanced.dimensions": "Dimensions personnalisées",
  "desktop.advanced.dimensionsDesc":
    "Laissez une valeur vide pour conserver les proportions originales.",
  "desktop.advanced.width": "Largeur",
  "desktop.advanced.height": "Hauteur",
  "desktop.advanced.retries": "Essais",
  "desktop.advanced.retriesDesc":
    "Réessayer les fragments échoués avant de conserver un résultat partiel.",
  "desktop.advanced.resumeCache": "Cache de reprise",
  "desktop.advanced.resumeCacheDesc":
    "Réutiliser les fragments après un enregistrement interrompu.",
  "desktop.advanced.choose": "Choisir…",
  "desktop.advanced.change": "Modifier…",
  "desktop.advanced.headers": "En-têtes de requête",
  "desktop.advanced.headersDesc":
    "Pour les visionneuses protégées. Envoyées seulement à l’origine de l’image.",
  // Extension job-tab user copy, rendered through the same `t(key, vars)`
  // shape; log and diagnostics lines stay literal English and never use these
  // keys. `test/ui-i18n.test.mjs` fails when the page renders a key outside
  // this table.
} as const;
