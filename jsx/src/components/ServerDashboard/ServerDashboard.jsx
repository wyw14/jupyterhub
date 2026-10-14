import React, { useEffect, useRef, useState, Fragment } from "react";
import { useSelector, useDispatch } from "react-redux";
import { debounce } from "lodash";
import PropTypes from "prop-types";
import ErrorAlert from "../../util/error";
import { User, Server } from "../../util/jhapiUtil";

import {
  Button,
  Form,
  FormControl,
  Card,
  CardGroup,
  Collapse,
  Stack,
} from "react-bootstrap";
import ReactObjectTableViewer from "../ReactObjectTableViewer/ReactObjectTableViewer";

import { Link, useSearchParams, useNavigate } from "react-router";
import { FaSort, FaSortUp, FaSortDown } from "react-icons/fa";

import "./server-dashboard.css";
import { timeSince } from "../../util/timeSince";
import { usePaginationParams } from "../../util/paginationParams";
import PaginationFooter from "../PaginationFooter/PaginationFooter";

// Stable identity for a user's server row.
// The server name ("" for the default server) is the stable identifier
// exposed by the API; unlike display_name or the transient user.server
// running-marker it does not change between a write and the next read,
// so per-row UI state is keyed by this instead of a mutable name/marker.
const getServerRowId = (user, server) =>
  `${user.name}\u0000${server.name || ""}`;

const RowListItem = ({ text }) => (
  <span className="server-dashboard-row-list-item">{text}</span>
);
RowListItem.propTypes = {
  text: PropTypes.string,
};

const ServerDashboard = (props) => {
  const base_url = window.base_url || "/";
  const [searchParams, setSearchParams] = useSearchParams();

  const [errorAlert, setErrorAlert] = useState(null);
  const [collapseStates, setCollapseStates] = useState({});
  // monotonically increasing id for list reads;
  // only the most recently requested read may update the page,
  // so out-of-order responses from concurrent updates are discarded
  const latestListRequest = useRef(0);

  let user_data = useSelector((state) => state.user_data);
  const user_page = useSelector((state) => state.user_page);

  const { offset, setOffset, handleLimit, limit } = usePaginationParams();

  const name_filter = searchParams.get("name_filter") || "";
  const sort = searchParams.get("sort") || "id";
  const state_filter = searchParams.get("state") || "";

  const total = user_page ? user_page.total : undefined;

  const dispatch = useDispatch();
  const navigate = useNavigate();

  var {
    updateUsers,
    shutdownHub,
    startServer,
    stopServer,
    deleteServer,
    startAll,
    stopAll,
  } = props;

  const dispatchPageUpdate = (data, page) => {
    // persist user data, triggers rerender
    dispatch({
      type: "USER_PAGE",
      value: {
        data: data,
        page: page,
      },
    });
  };

  const setNameFilter = (new_name_filter) => {
    // persist ?name_filter parameter
    // store in url param, clear when value is empty
    setSearchParams((params) => {
      // clear offset when name filter changes
      if (new_name_filter !== name_filter) {
        params.delete("offset");
      }
      if (new_name_filter) {
        params.set("name_filter", new_name_filter);
      } else {
        params.delete("name_filter");
      }
      return params;
    });
  };

  const setSort = (sort) => {
    // persist ?sort parameter
    // store in url param, clear when value is default ('id')
    setSearchParams((params) => {
      if (sort === "id") {
        params.delete("id");
      } else {
        params.set("sort", sort);
      }
      return params;
    });
  };

  const setStateFilter = (new_state_filter) => {
    // persist ?state filter
    // store in url param, clear when value is default ('')
    setSearchParams((params) => {
      // clear offset when filter changes
      if (new_state_filter !== state_filter) {
        params.delete("offset");
      }
      if (!new_state_filter) {
        params.delete("state");
      } else {
        params.set("state", new_state_filter);
      }
      return params;
    });
  };

  // single callback to reload the page
  // uses current state
  const loadPageData = () => {
    // every read gets a monotonically increasing request id;
    // only the latest requested read is allowed to land,
    // so out-of-order responses from concurrent reads/actions
    // can never overwrite a newer, confirmed configuration
    const requestId = ++latestListRequest.current;
    (async () => {
      let data;
      try {
        data = await updateUsers({
          offset,
          limit,
          name_filter,
          sort,
          state: state_filter,
        });
      } catch (e) {
        // a failed read must not clear the last known-good list
        if (requestId === latestListRequest.current) {
          console.error("Failed to update user list.", e);
          setErrorAlert("Failed to update user list.");
        }
        return;
      }
      // a newer read was started while this one was in flight
      if (requestId !== latestListRequest.current) return;
      if (!data || !Array.isArray(data.items) || !data._pagination) {
        // malformed/garbled response (e.g. an API error body):
        // retain the currently held, still-valid list
        console.error("Invalid user list response.", data);
        setErrorAlert("Failed to update user list.");
        return;
      }
      if (
        data._pagination.offset &&
        data._pagination.total <= data._pagination.offset
      ) {
        // reset offset if we're out of bounds,
        // then load again
        setOffset(0);
        return;
      }
      // actually update page data
      dispatchPageUpdate(data.items, data._pagination);
    })();
    // returns cancellation callback
    return () => {
      // invalidate this and any older in-flight read
      // (e.g. query params changed while waiting for the response)
      if (latestListRequest.current === requestId) {
        latestListRequest.current += 1;
      }
    };
  };

  useEffect(() => {
    return loadPageData();
  }, [limit, name_filter, offset, sort, state_filter]);

  // Revoke per-row UI state only when the server entry itself has
  // disappeared (i.e. deleted). Renames and ordinary refreshes keep
  // the same stable entry, so its state must be preserved.
  useEffect(() => {
    setCollapseStates((previous) => {
      const validIds = new Set();
      for (const user of user_data || []) {
        for (const server of Object.values(user.servers || {})) {
          validIds.add(getServerRowId(user, server));
        }
      }
      const next = {};
      let changed = false;
      for (const [id, isOpen] of Object.entries(previous)) {
        if (validIds.has(id)) {
          next[id] = isOpen;
        } else {
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [user_data]);

  if (!user_data || !user_page) {
    return <div data-testid="no-show"></div>;
  }

  const handleSearch = debounce(async (event) => {
    setNameFilter(event.target.value);
  }, 300);

  const ServerButton = ({
    server,
    user,
    action,
    name,
    variant,
    extraClass,
  }) => {
    var [isDisabled, setIsDisabled] = useState(false);
    return (
      <Button
        size="xs"
        variant={variant}
        className={extraClass}
        disabled={isDisabled || server.pending}
        onClick={() => {
          setIsDisabled(true);
          action(user.name, server.name)
            .then((res) => {
              if (res.status < 300) {
                loadPageData();
              } else {
                setErrorAlert(`Failed to ${name.toLowerCase()}.`);
                setIsDisabled(false);
              }
              return res;
            })
            .catch(() => {
              setErrorAlert(`Failed to ${name.toLowerCase()}.`);
              setIsDisabled(false);
            });
        }}
      >
        {name}
      </Button>
    );
  };

  ServerButton.propTypes = {
    server: Server,
    user: User,
    action: PropTypes.string,
    name: PropTypes.string,
    variant: PropTypes.string,
    extraClass: PropTypes.string,
  };

  const StopServerButton = ({ server, user }) => {
    if (!server.ready) {
      return null;
    }
    return ServerButton({
      server,
      user,
      action: stopServer,
      name: "Stop Server",
      variant: "danger",
      extraClass: "stop-button",
    });
  };

  StopServerButton.propTypes = {
    server: Server,
    user: User,
  };

  const DeleteServerButton = ({ server, user }) => {
    if (!server.name) {
      // It's not possible to delete unnamed servers
      return null;
    }
    if (server.ready || server.pending) {
      return null;
    }
    return ServerButton({
      server,
      user,
      action: deleteServer,
      name: "Delete Server",
      variant: "danger",
      extraClass: "stop-button",
    });
  };

  DeleteServerButton.propTypes = {
    server: Server,
    user: User,
  };

  const StartServerButton = ({ server, user }) => {
    if (server.ready) {
      return null;
    }
    return ServerButton({
      server,
      user,
      action: startServer,
      name: server.pending ? "Server is pending" : "Start Server",
      variant: "success",
      extraClass: "start-button",
    });
  };

  StartServerButton.propTypes = {
    server: Server,
    user: User,
  };

  const SpawnPageButton = ({ server, user }) => {
    if (server.ready) {
      return null;
    }
    return (
      <a
        href={`${base_url}spawn/${user.name}${
          server.name ? "/" + server.name : ""
        }`}
      >
        <Button variant="light" size="xs">
          Spawn Page
        </Button>
      </a>
    );
  };

  SpawnPageButton.propTypes = {
    server: Server,
    user: User,
  };

  const AccessServerButton = ({ server }) => {
    if (!server.ready) {
      return null;
    }
    return (
      <a href={server.url || ""}>
        <Button variant="primary" size="xs">
          Access Server
        </Button>
      </a>
    );
  };
  AccessServerButton.propTypes = {
    server: Server,
  };

  const EditUserButton = ({ user }) => {
    return (
      <Button
        size="xs"
        variant="light"
        onClick={() =>
          navigate("/edit-user", {
            state: {
              username: user.name,
              has_admin: user.admin,
            },
          })
        }
      >
        Edit User
      </Button>
    );
  };

  EditUserButton.propTypes = {
    user: User,
  };

  const ServerRowTable = ({ data, exclude }) => {
    const sortedData = Object.keys(data)
      .sort()
      .reduce(function (result, key) {
        if (exclude && exclude.includes(key)) {
          return result;
        }
        let value = data[key];
        switch (key) {
          case "last_activity":
          case "created":
          case "started":
            // format timestamps
            value = value ? timeSince(value) : value;
            break;
        }
        if (Array.isArray(value)) {
          value = (
            <Fragment>
              {value.sort().flatMap((v) => (
                <RowListItem text={v} />
              ))}
            </Fragment>
          );
        }
        result[key] = value;
        return result;
      }, {});
    return (
      <ReactObjectTableViewer
        className="table table-striped table-bordered"
        style={{
          padding: "3px 6px",
          margin: "auto",
        }}
        keyStyle={{
          padding: "4px",
        }}
        valueStyle={{
          padding: "4px",
        }}
        data={sortedData}
      />
    );
  };

  ServerRowTable.propTypes = {
    data: Server,
    exclude: PropTypes.arrayOf(PropTypes.string),
  };

  const ServerRow = ({ user, server }) => {
    const serverNameDash = server.name ? `-${server.name}` : "";
    const userServerName = user.name + serverNameDash;
    // per-row state is keyed by the stable server identity,
    // not the display name or the running/default URL marker
    const serverRowId = getServerRowId(user, server);
    const open = collapseStates[serverRowId] || false;
    return (
      <Fragment key={`${userServerName}-row`}>
        <tr
          key={`${userServerName}-row`}
          data-testid={`user-row-${userServerName}`}
          className="user-row"
        >
          <td data-testid="user-row-name">
            <span>
              <Button
                onClick={() =>
                  setCollapseStates({
                    ...collapseStates,
                    [serverRowId]: !open,
                  })
                }
                aria-controls={`${userServerName}-collapse`}
                aria-expanded={open}
                data-testid={`${userServerName}-collapse-button`}
                variant={open ? "secondary" : "primary"}
                size="sm"
              >
                <span className="fa fa-caret-down"></span>
              </Button>{" "}
            </span>
            <span data-testid={`user-name-div-${userServerName}`}>
              {user.name}
            </span>
          </td>

          <td data-testid="user-row-server">
            <p className="text-secondary">{server.name}</p>
          </td>
          <td data-testid="user-row-last-activity">
            {server.last_activity ? timeSince(server.last_activity) : "Never"}
          </td>
          <td data-testid="user-row-server-start-time">
            {server.started ? timeSince(server.started) : "Never"}
          </td>
          <td data-testid="user-row-profile-used">
            {(server.user_options && server.user_options.profile) || ""}
          </td>
          <td data-testid="user-row-server-activity" className="actions">
            <StartServerButton server={server} user={user} />
            <StopServerButton server={server} user={user} />
            <DeleteServerButton server={server} user={user} />
            <AccessServerButton server={server} />
            <SpawnPageButton server={server} user={user} />
            <EditUserButton user={user} />
          </td>
        </tr>
        <tr key={`${userServerName}-detail`}>
          <td
            colSpan={7}
            style={{ padding: 0 }}
            data-testid={`${userServerName}-td`}
          >
            <Collapse in={open} data-testid={`${userServerName}-collapse`}>
              <CardGroup
                id={`${userServerName}-card-group`}
                style={{ width: "100%", margin: "0 auto", float: "none" }}
              >
                <Card style={{ width: "100%", padding: 3, margin: "0 auto" }}>
                  <Card.Title>User</Card.Title>
                  <ServerRowTable data={user} exclude={["server", "servers"]} />
                </Card>
                <Card style={{ width: "100%", padding: 3, margin: "0 auto" }}>
                  <Card.Title>Server</Card.Title>
                  <ServerRowTable data={server} />
                </Card>
              </CardGroup>
            </Collapse>
          </td>
        </tr>
      </Fragment>
    );
  };

  ServerRow.propTypes = {
    user: User,
    server: Server,
  };

  const serverRows = user_data.flatMap((user) => {
    // Rows come only from the real servers map, keyed by the stable server
    // name ("" is the default server) and always carrying the server model.
    // Never synthesise a default row from the legacy user.server URL,
    // which is just a running-marker that flips between URL and null
    // between a write and the next read; that produced phantom rows for
    // users with no servers at all or with only a named server, making
    // the empty and single-server lists unstable.
    // eslint-disable-next-line react/prop-types
    const userServers = Object.values(user.servers || {});
    return userServers.map((server) => ServerRow({ user, server }));
  });

  return (
    <div className="container" data-testid="container">
      <ErrorAlert errorAlert={errorAlert} setErrorAlert={setErrorAlert} />
      <div className="server-dashboard-container">
        <Stack direction="horizontal" className="pb-3 mb-2" gap={3}>
          <Button
            variant="primary"
            className="start-all"
            data-testid="start-all"
            title="Start all default servers on the current page"
            onClick={() => {
              Promise.all(startAll(user_data.map((e) => e.name)))
                .then((res) => {
                  let failedServers = res.filter((e) => !e.ok);
                  if (failedServers.length > 0) {
                    setErrorAlert(
                      `Failed to start ${failedServers.length} ${
                        failedServers.length > 1 ? "servers" : "server"
                      }. ${
                        failedServers.length > 1 ? "Are they " : "Is it "
                      } already running?`,
                    );
                  }
                  return res;
                })
                .then((res) => {
                  loadPageData();
                  return res;
                })
                .catch(() => setErrorAlert(`Failed to start servers.`));
            }}
          >
            Start All
          </Button>

          <Button
            variant="danger"
            className="stop-all"
            data-testid="stop-all"
            title="Stop all servers including named servers on the current page"
            onClick={() => {
              Promise.all(stopAll(user_data.map((e) => e.name)))
                .then((res) => {
                  // Array of arrays of servers for each user
                  let failedServers = res.flat().filter((e) => !e.ok);
                  if (failedServers.length > 0) {
                    setErrorAlert(
                      `Failed to stop ${failedServers.length} ${
                        failedServers.length > 1 ? "servers" : "server"
                      }. ${
                        failedServers.length > 1 ? "Are they " : "Is it "
                      } already stopped?`,
                    );
                  }
                  return res;
                })
                .then((res) => {
                  loadPageData();
                  return res;
                })
                .catch(() => setErrorAlert(`Failed to stop servers.`));
            }}
          >
            Stop All
          </Button>
          <div className="ms-auto">
            <Button
              className=""
              variant="danger"
              id="shutdown-button"
              onClick={shutdownHub}
            >
              Shutdown Hub
            </Button>
          </div>
        </Stack>

        <Stack direction="horizontal" className="pb-1 " gap={3}>
          <div>
            <FormControl
              type="text"
              name="user_search"
              placeholder="Search Users"
              aria-label="user-search"
              defaultValue={name_filter}
              onChange={handleSearch}
            />
          </div>
          <div className="me-auto">
            <Form.Check
              inline
              title="check to only show running servers, otherwise show all"
            >
              <Form.Check.Input
                type="checkbox"
                name="active_servers"
                id="active-servers-filter"
                checked={state_filter == "active"}
                onChange={(event) => {
                  setStateFilter(event.target.checked ? "active" : null);
                }}
              />
              <Form.Check.Label htmlFor="active-servers-filter">
                Only Active Servers
              </Form.Check.Label>
            </Form.Check>
          </div>
          <Link to="/add-users">
            <Button variant="light" className="add-users-button">
              Add Users
            </Button>
          </Link>
          <Link to="/groups">
            <Button variant="light">Manage Groups</Button>
          </Link>
        </Stack>

        <table className="table table-bordered table-hover">
          <thead className="admin-table-head">
            <tr>
              <th id="user-header">
                User{" "}
                <SortHandler
                  currentSort={sort}
                  setSort={setSort}
                  sortKey="name"
                  testid="user-sort"
                />
              </th>
              <th id="server-header">Server</th>
              <th id="last-activity-header">
                Last Activity{" "}
                <SortHandler
                  currentSort={sort}
                  setSort={setSort}
                  sortKey="last_activity"
                  testid="last-activity-sort"
                />
              </th>
              <th id="server-start-time-header">Server Start Time</th>
              <th id="profile-used-header">Profile</th>
              <th id="actions-header">Actions</th>
            </tr>
          </thead>
          <tbody>{serverRows}</tbody>
        </table>
        <PaginationFooter
          // use user_page for display, which is what's on the page
          // setOffset immediately updates url state and _requests_ an update
          // but takes finite time before user_page is updated
          offset={user_page.offset}
          limit={limit}
          visible={user_data.length}
          total={total}
          next={() => setOffset(user_page.offset + limit)}
          prev={() =>
            setOffset(limit > user_page.offset ? 0 : user_page.offset - limit)
          }
          handleLimit={handleLimit}
        />
        <br></br>
      </div>
    </div>
  );
};

ServerDashboard.propTypes = {
  user_data: PropTypes.arrayOf(User),
  updateUsers: PropTypes.func,
  shutdownHub: PropTypes.func,
  startServer: PropTypes.func,
  stopServer: PropTypes.func,
  deleteServer: PropTypes.func,
  startAll: PropTypes.func,
  stopAll: PropTypes.func,
  dispatch: PropTypes.func,
};

const SortHandler = (props) => {
  const { currentSort, setSort, sortKey, testid } = props;

  const currentlySorted = currentSort && currentSort.endsWith(sortKey);
  const descending = currentSort && currentSort.startsWith("-");
  return (
    <div
      className="sort-icon"
      data-testid={testid}
      onClick={() => {
        if (!currentlySorted) {
          setSort(sortKey);
        } else if (descending) {
          setSort(sortKey);
        } else {
          setSort("-" + sortKey);
        }
      }}
    >
      {!currentlySorted ? (
        <FaSort />
      ) : descending ? (
        <FaSortDown />
      ) : (
        <FaSortUp />
      )}
    </div>
  );
};

SortHandler.propTypes = {
  currentSort: PropTypes.string,
  setSort: PropTypes.func,
  sortKey: PropTypes.string,
  testid: PropTypes.string,
};

export default ServerDashboard;
