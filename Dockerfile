ARG PHP_VERSION
ARG MYSQL_VERSION=5.7
ARG ELASTICSEARCH_VERSION=7.x

FROM ubuntu:latest
# Set the timezone
ENV TZ=Europe/Bucharest

ENV PHP_VERSION=8.3
# Log the PHP_VERSION value
RUN echo "PHP_VERSION is set to ${PHP_VERSION}"

# Set DEBIAN_FRONTEND to noninteractive
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update -y --fix-missing
RUN apt-get install -y iputils-ping nano gnupg2 curl make ca-certificates gnupg

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
ENV NODE_MAJOR=20
RUN echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list
RUN apt-get update && apt-get install nodejs -y

RUN apt update
RUN apt install -y lsb-release ca-certificates apt-transport-https software-properties-common
RUN add-apt-repository ppa:ondrej/php

# Install Yarn
RUN apt-get update \
    && apt-get install -y apt-transport-https \
    && curl -sS https://dl.yarnpkg.com/debian/pubkey.gpg | apt-key add - \
    && echo "deb https://dl.yarnpkg.com/debian/ stable main" | tee /etc/apt/sources.list.d/yarn.list \
    && apt-get update \
    && apt-get install -y yarn --no-install-recommends \
    && apt-get purge -y --auto-remove -o APT::AutoRemove::RecommendsImportant=false -o APT::AutoRemove::SuggestsImportant=false
RUN yarn set version latest

# Install Redis
RUN apt-get update && \
    apt-get install -y redis-server

# Install Gulp using Yarn
RUN yarn global add gulp-cli

# Install PHP dependencies
RUN apt-get update && \
    apt-get install -y g++ \
                      openssl \
                      libc-client-dev \
                      libkrb5-dev \
                      libxml2-dev \
                      libfreetype6-dev \
                      libgd-dev \
                      libldap2-dev \
                      libsasl2-dev \
                      libmcrypt-dev \
                      libcurl4-openssl-dev \
                      libgmp-dev \
                      --no-install-recommends && \
    apt-get purge -y --auto-remove -o APT::AutoRemove::RecommendsImportant=false -o APT::AutoRemove::SuggestsImportant=false && \
    ln -fs /usr/lib/x86_64-linux-gnu/libldap.so /usr/lib/

# Install required packages
RUN apt-get update && \
    apt-get install -y tzdata gnupg mysql-server mysql-client php${PHP_VERSION} apache2 curl php-cli php-zip php-bcmath php-mysql php-ldap php${PHP_VERSION}-xml php-curl php-mbstring php-soap unzip && \
    rm -rf /var/lib/apt/lists/*

# Install Composer
RUN curl -sS https://getcomposer.org/installer -o composer-setup.php && \
    php composer-setup.php --install-dir=/usr/local/bin --filename=composer && \
    rm composer-setup.php

# Enable GD extension
RUN apt-get update && \
    apt-get install -y php${PHP_VERSION}-gd php${PHP_VERSION}-imap && \
    rm -rf /var/lib/apt/lists/*

# Modify PHP memory limit
RUN sed -i "s/memory_limit = .*/memory_limit = 1024M/" /etc/php/${PHP_VERSION}/apache2/php.ini && \
    sed -i "s/memory_limit = .*/memory_limit = 1024M/" /etc/php/${PHP_VERSION}/cli/php.ini

# Setup PHP error reportinc to E_ALL & ~E_NOTICE & ~E_DEPRECATED
RUN sed -i "s/^error_reporting = .*/error_reporting = E_ALL \& ~E_NOTICE \& ~E_DEPRECATED/" /etc/php/${PHP_VERSION}/apache2/php.ini
RUN sed -i "s/^error_reporting = .*/error_reporting = E_ALL \& ~E_NOTICE \& ~E_DEPRECATED/" /etc/php/${PHP_VERSION}/cli/php.ini

# Increase file upload size limit
RUN sed -i "s/upload_max_filesize = .*/upload_max_filesize = 8M/" /etc/php/${PHP_VERSION}/apache2/php.ini && \
    sed -i "s/post_max_size = .*/post_max_size = 8M/" /etc/php/${PHP_VERSION}/apache2/php.ini && \
    sed -i "s/upload_max_filesize = .*/upload_max_filesize = 8M/" /etc/php/${PHP_VERSION}/cli/php.ini && \
    sed -i "s/post_max_size = .*/post_max_size = 8M/" /etc/php/${PHP_VERSION}/cli/php.ini

# Install Java (required for Elasticsearch)
RUN apt-get update && \
    apt-get install -y default-jre && \
    rm -rf /var/lib/apt/lists/*

# Install gnupg2 (required for importing GPG key)
RUN apt-get update && \
    apt-get install -y gnupg2 && \
    rm -rf /var/lib/apt/lists/*

# Install Elasticsearch
ARG ELASTICSEARCH_VERSION
RUN curl -fsSL https://artifacts.elastic.co/GPG-KEY-elasticsearch | apt-key add - && \
    echo "deb https://artifacts.elastic.co/packages/$ELASTICSEARCH_VERSION/apt stable main" | tee /etc/apt/sources.list.d/elastic-$ELASTICSEARCH_VERSION.list && \
    apt-get update && \
    apt-get install -y elasticsearch && \
    rm -rf /var/lib/apt/lists/*

# Configure Elasticsearch
# Modify Elasticsearch JVM heap size
# Create a new file to override JVM options
# RUN echo "-Xmx4g" >> /etc/elasticsearch/jvm.options.d/override.options
# RUN echo "-Xms4g" >> /etc/elasticsearch/jvm.options.d/override.options

COPY elasticsearch.yml /etc/elasticsearch/elasticsearch.yml

# Configure Mysql
RUN chmod 644 /etc/mysql/my.cnf
COPY my.cnf /etc/mysql/my.cnf
RUN chmod 644 /etc/mysql/my.cnf

# Set the correct permissions for Elasticsearch directories
RUN chown -R elasticsearch:elasticsearch /usr/share/elasticsearch && \
    chown -R elasticsearch:elasticsearch /var/lib/elasticsearch && \
    chown -R elasticsearch:elasticsearch /etc/elasticsearch && \
    chown -R elasticsearch:elasticsearch /var/log/elasticsearch

# Configure MySQL
RUN service mysql start && \
    sleep 5 && \
    mysql -u root -e "ALTER USER 'root'@'localhost' IDENTIFIED BY 'root';" && \
    mysql -u root -e "GRANT GRANT OPTION ON *.* TO 'root'@'localhost';" && \
    mysql -u root -e "CREATE USER 'root'@'%' IDENTIFIED BY 'root'" && \
    mysql -u root -e "GRANT ALL PRIVILEGES ON *.* TO 'root'@'%';" && \
    mysql -u root -e "FLUSH PRIVILEGES;"

# Enable mod_rewrite module and configure Apache
RUN a2enmod rewrite
# Copy the custom apache2.conf file to the container
COPY apache2.conf /etc/apache2/apache2.conf


RUN mkdir /app
WORKDIR /app

# Start services
CMD service apache2 start && \
    service mysql start && \
    sed -i "s/\${container_ip}/$(hostname -i)/" /etc/elasticsearch/elasticsearch.yml && \
    service elasticsearch start && \
    tail -f /dev/null
