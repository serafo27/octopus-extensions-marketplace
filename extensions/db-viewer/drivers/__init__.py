"""The kinds of database the server can talk to, by the `driver` of a connection."""
from . import mysql

DRIVERS = {mysql.NAME: mysql}
