## Changes to the community edition of overleaf

### 1. Changes

2021-07-13:

- code cleanup
- Recognise first_name and last_name if provided by the shibboleth attributes (if upgrading this to this feature, existing accounts are also updated if the firstname is still the account name or empty or the lastname is empty!)
- remove the login/register button from the templates

2021-06-26:

- first shibboleth version
- change the login template, add a shibboleth login to /Shibboleth.sso/Login (hardcoded)
- add a second login-API point (POST request) /shibboleth_login
- authenticated users are login with the attribute which is defined by the environment variable `REMOTE_USER` (`REMOTE_USER` is the default, I prefer `uid`)
- fix some german translations

### 2. Notes

- the shibboleth attributes are stored in the request-header, usually in `req` in:

  `sharelatex/web/app/src/Features/Authentication/AuthenticationController.js`

- admin user can be created during first start: call `/launchpad`

### 3. Development

- to do some code development with docker container, mount the code base from outside into `/var/www/sharelatex`

- restart the we app inside the container with

  ```bash
  cd /etc/service
  sv status web-sharelatex
  # this gives a PID
  kill -9 PID
  ```

  

