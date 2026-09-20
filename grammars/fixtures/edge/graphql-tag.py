"""A module docstring, which is a triple-quoted string and nothing more."""

from gql import gql

QUERY = gql(
    """
    query Viewer {
      viewer {
        login
      }
    }
    """
)

PLAIN = """
    Another triple-quoted string, this one not handed to gql().
"""
