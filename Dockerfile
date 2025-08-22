#FROM sharelatex/sharelatex:2.6.2
#FROM sharelatex/sharelatex:2.7.0
#FROM aifajupyter/sharelatex-base-aifa:latest
FROM aifajupyter/sharelatex-base-aifa-tl2024-2.6.4:release-20250717
LABEL maintainer=ocordes@astro.uni-bonn.de

# update tlmgr
RUN tlmgr update --self --all

# install full latex
##RUN tlmgr install scheme-full
RUN tlmgr install collection-latex
RUN tlmgr install collection-mathscience
RUN tlmgr install collection-fontsrecommended
RUN tlmgr install collection-langgerman
RUN tlmgr install collection-langfrench
RUN tlmgr install collection-langitalian
RUN tlmgr install collection-langspanish
RUN tlmgr install collection-langportuguese
RUN tlmgr install collection-langgreek
RUN tlmgr install collection-langpolish
RUN tlmgr install collection-bibtexextra
RUN tlmgr install collection-formatsextra
RUN tlmgr install collection-fontsextra
RUN tlmgr install collection-fontsrecommended
RUN tlmgr install collection-humanities
RUN tlmgr install collection-latexextra
RUN tlmgr install collection-latexrecommended
RUN tlmgr install collection-luatex
#RUN tlmgr install collection-pictures
#RUN tlmgr install collection-pstricks
#RUN tlmgr install collection-publishers
#RUN tlmgr install collection-xetex

# copy the Shibboleth modifications
COPY patches/sharelatex/web/app/views/layout/navbar.pug /var/www/sharelatex/web/app/views/layout/navbar.pug
COPY patches/sharelatex/web/app/views/user/login.pug /var/www/sharelatex/web/app/views/user/login.pug
COPY patches/sharelatex/web/app/views/user/settings.pug /var/www/sharelatex/web/app/views/user/settings.pug
COPY patches/sharelatex/web/app/src/router.js /var/www/sharelatex/web/app/src/router.js
COPY patches/sharelatex/web/app/src/Features/Authentication/AuthenticationController.js /var/www/sharelatex/web/app/src/Features/Authentication/AuthenticationController.js
COPY patches/sharelatex/web/app/src/Features/Authentication/AuthenticationManager.js /var/www/sharelatex/web/app/src/Features/Authentication/AuthenticationManager.js

# copy the patched Language detection part 
COPY patches/sharelatex/web/app/src/infrastructure/Translations.js /var/www/sharelatex/web/app/src/infrastructure/Translations.js

# locale corrections
COPY locales/de.json /var/www/sharelatex/web/locales/de.json
COPY locales/en.json /var/www/sharelatex/web/locales/en.json


## install the wrapper
COPY timeout_fix /usr/bin/timeout_fix

# adjust the latemk command with timeout option
COPY latexmkrc_timeout /var/www/.latexmkrc
